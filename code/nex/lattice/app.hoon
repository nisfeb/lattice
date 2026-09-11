::  nex/lattice/app: the grubbery-native %lattice application nexus.
::
::  Lattice is a nexus, not a gall agent. The tree it owns:
::    /main.sig            the action WRITER. Takes %know-action / %pub-action
::                         pokes and serialises every mutation (avoids index races)
::    /know/vault/<key>/entry   one know-entry grub per key (private)
::    /know/trash          derived trash index
::    /pub/vault/<spur>    published page grubs (public)
::    /pub/index           derived page index (parity hash)
::    /ui/main.sig         binds /apps/lattice; dispatches to per-request fibers
::    /ui/requests/<id>    one ephemeral fiber per in-flight HTTP request
::    /ui/views/page.html  the web reader grub
::    /sub, /idx           follows + the grub-native term index
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
/<  lgmi  /lib/lattice-gmi.hoon
/<  le   /lib/lattice-eval.hoon
/<  lu   /lib/lattice-urls.hoon
/<  pg   /lib/lattice-pg.hoon
/<  gfm  /lib/lattice-md.hoon
/<  tpl  /lib/lattice-templates.hoon
/<  lkv  /lib/lattice-know-view.hoon
::  imports resolve relative to THIS file's dir (/nex/lattice), not /nex.
::  guestbook writes `guestbook/icon.svg` only because its source sits AT /nex.
/<  icon  icon.svg
/<  pjs  prism.js
/<  uih  ui-app/index.html
/<  uij  ui-app/app.js
/<  vjs  ui-app/vault.js
/<  lc   /lib/lattice-comment.hoon
/<  lb   /lib/lattice-bookmark.hoon
/<  lh   /lib/lattice-history.hoon
/<  lcl  /lib/lattice-clip.hoon
/<  li   /lib/lattice-index.hoon
/<  ls   /lib/lattice-share.hoon
::  the commons mirror (docs/obelisk-mirror.md). lm builds the urQL and
::  carries the result-type vocabulary matched to %obelisk the DESK.
/<  lm   /lib/lattice-mirror.hoon
=<  ^-  nexus:nexus
    |%
    ++  on-load
      |=  =ball:tarball
      ^-  bole:tarball
      ::  Every persistent path needs a covering row. spin rebuilds the
      ::  bole from scratch and DROPS anything uncovered. The %fall %| over
      ::  /know/vault copies the whole existing subtree, so dynamically
      ::  created entries survive reload. Versioning is the manifest row
      ::  (grubbery's loader has no read-side ver gate).
      %+  spin:loader  ball
      :~  (manifest:loader 0)
        ::  tile.json: the launcher (tiles nexus) lists only apps that carry
        ::  one. Without it lattice is invisible in the grubbery home UI.
        ::  %over so the tile stays current across reloads.
            :^  %over  %&  [/ %'tile.json']
            :-  [/ %json]
            %-  pairs:enjs:format
            :~  title+s+'Lattice'
                info+s+'Pages, knowledge & publishing'
                color+s+'#4a7c59'
                ::  the tiles icon route matches the app SLUG (name before the
                ::  first dot), not the folder name.
                image+s+'/grubbery/tiles/icon/lattice'
                href+s+'/apps/lattice'
            ==
        ::  alias.json: WHO THIS NEXUS CLAIMS TO BE. The shell reads it and
        ::  enters the claim in its alias book, which is how a peer resolves
        ::  the name `lattice` to wherever this instance actually lives in
        ::  that ship's namespace rather than to a path we both hardcoded.
        ::  Inert until a shell is there to read it; one grub, and the whole
        ::  of what this app says about its own identity.
            :^  %over  %&  [/ %'alias.json']
            :-  [/ %json]
            %-  pairs:enjs:format
            :~  name+s+'lattice'
                description+s+'Pages, knowledge & publishing'
            ==
        ::  link.json: the same claim in the form the shell actually SCANS.
        ::  +read-app-aliases walks /apps and each desk's data children
        ::  reading link.json, not alias.json, and folds what it finds into
        ::  the /sys/link registry. Without this grub lattice claims the name
        ::  nowhere, and a peer cannot resolve @lattice to wherever this
        ::  instance lives - which is the whole problem once desks are named
        ::  at install time. See +app-base for the constant it should retire.
            :^  %over  %&  [/ %'link.json']
            :-  [/ %json]
            %-  pairs:enjs:format
            :~  name+s+'lattice'
                description+s+'Pages, knowledge & publishing'
            ==
        ::  weir.json: WHAT THIS NEXUS REACHES OUTSIDE ITS OWN TREE, and why,
        ::  in words meant for the person being asked. A desk-installed
        ::  instance is created with an empty weir - permit nothing - and
        ::  earns each road through this file and the shell's consent.
        ::  Lattice's own subtree is not declared: it never crosses its own
        ::  boundary.
            [%over %& [/ %'weir.json'] [[/ %json] weir-json]]
            [%over %& [/ %'icon.svg'] [[/ %mime] icon]]
            [%over %& [/ %'prism.js'] [[/ %mime] pjs]]
        ::  the lattice-hosted UI (docs/ui-migration/PLAN.md): real files in
        ::  ui-app/, laid as grubs, served at /apps/lattice/app. The core
        ::  stays lean (assets in cords wedge every request fiber).
        ::  css is inlined in index.html (every asset request costs ~2s on the
        ::  serialized pier, so the shell ships as one document + one script).
            [%over %& [/app %'index.html'] [[/ %mime] uih]]
            [%over %& [/app %'app.js'] [[/ %mime] uij]]
        ::  vault.js: shared export/restore + the Settings backup UI. Served
        ::  standalone so the editor bundle and the settings page (a separate
        ::  document) share one tar writer/reader instead of two.
            [%over %& [/app %'vault.js'] [[/ %mime] vjs]]
            [%fall %& [/ %'main.sig'] [[/ %sig] ~]]
        ::  /legacy: the retired-agent marker lives here (see +legacy-mark-road)
            [%fall %| /legacy empty-dir:loader]
            [%fall %| /know/vault empty-dir:loader]
            [%fall %| /know/trash-vault empty-dir:loader]
            [%fall %& [/know %trash] [[/lattice %know-index] *know-index:lk]]
            [%fall %| /pub/vault empty-dir:loader]
            [%fall %& [/pub %index] [[/lattice %pub-index] *pub-index:lp]]
        ::  /pub/meta: the mesa publish sequence counter (docs D1). Every
        ::  namespace publish grows one /pub/index/<seq> manifest binding and
        ::  takes its seq from here (monotonic, never reused). A covering row
        ::  so the counter survives reload. A dropped counter would re-grow
        ::  seq 1 over an already-bound spur.
        ::
        ::  The mark is grubbery's OWN [/ %ud], not a lattice-private one. A
        ::  grub laid under a mark that has no source file gets a BOOM sang
        ::  (raw noun + tang, no vase), and the first +read-pub-seq would
        ::  crash on it, killing the writer fiber and hanging every publish.
        ::  The counter is one bare atom and /mar/ud.hoon already is that mark.
            [%fall %& [/pub %meta] [[/ %ud] 0]]
        ::  There is no pointer row. The subscription rev rides the page
        ::  keep's own wave (see /sub/pages), and nothing writes or reads
        ::  /pub/note/ptr. A pier that still carries that grub keeps it as
        ::  inert state. Fall rows only lay absent grubs, so omitting the row
        ::  is safe either way.
        ::  HTTP front-end: ui/main.sig binds /apps/lattice and dispatches each
        ::  request into a per-request fiber under ui/requests. The web reader is
        ::  rendered dynamically per request (no static page grub).
            [%fall %& [/ui %'main.sig'] [[/ %sig] ~]]
            [%fall %| /ui/requests empty-dir:loader]
        ::  /sub/follows: the ships this user follows. A covering file row
        ::  (not an empty-dir) so the set survives reload.
            [%fall %& [/sub %follows] [[/lattice %sub-follows] *follows:lp]]
        ::  /sub/pages/: one grub per live per-file subscription. Each grub's
        ::  on-file spawns a keep fiber that wakes whenever the peer edits that
        ::  remote page. /sub + /unsub make/cull these grubs.
            [%fall %| /sub/pages empty-dir:loader]
        ::  /page/: programmable pages (docs/platform.md step 2). One dir per
        ::  page; the code grub's on-file fiber is the evaluator.
            [%fall %| /page empty-dir:loader]
        ::  /template/: reusable page-tree templates (inert code grubs, never
        ::  evaluated, no [%page ...] on-file match). Covered so saved and
        ::  shipped templates survive reload, like /page and /know/vault.
            [%fall %| /template empty-dir:loader]
        ::  /comments/<page>/<id>: one grub per page comment (Urbit-ships-only).
        ::  Page content stays under /page (owner-only weir). Comments are the one
        ::  area other ships may append to (via the public inbox fiber, added with
        ::  the cross-ship path). The owner writer (main.sig) also writes here.
            [%fall %| /comments empty-dir:loader]
        ::  /bookmarks: the browser's saved-page list (newest first). A covering
        ::  file row (like /sub/follows) so it survives reload.
            [%fall %& [/ %bookmarks] [[/lattice %bookmarks] *bookmarks:lb]]
        ::  /history: pages seen in the reader (newest first). Same covering-row
        ::  shape as /bookmarks. Entries expire after lattice-history's ttl.
            [%fall %& [/ %history] [[/lattice %history] *history:lh]]
        ::  /rev: a tiny change beacon bumped on every writer mutation. Open web
        ::  readers keep-SSE this one small grub (no-blot) and reload on any change,
        ::  a lightweight live-update signal that doesn't stream a page's heavy
        ::  compiled grub, and works where grubbery's ?blot=/txt keep does not.
            [%fall %& [/beacon %rev] [[/ %json] (numb:enjs:format 0)]]
        ::  /idx: the grub-native term index (docs/native-index.md). 256 bucket
        ::  grubs, each term -> (key -> [scope tf]). ONE covering %fall row. A
        ::  nexus reload rewrites its whole covered subtree, so without a row
        ::  here the whole index is deleted on every load.
            [%fall %| /idx/b empty-dir:loader]
        ::  /mirror: the obelisk commons mirror (docs/obelisk-mirror.md).
        ::  Callers run their own round-trips against %obelisk the DESK,
        ::  each verified by a nonce echoed through the query, so the
        ::  shared /server materialization cannot cross results between
        ::  callers. mirror.sig is the reconciler, cursor its per-source
        ::  memory, config.json the enabled flag.
            [%fall %& [/mirror %'mirror.sig'] [[/ %sig] ~]]
            [%fall %& [/mirror %cursor] [[/lattice %mirror-cursor] *mirror-cursor:lm]]
            [%fall %& [/mirror %'config.json'] [[/ %json] (pairs:enjs:format ~[['enabled' b+|]])]]
        ::  /shared: notices other ships sent about files they granted us (see
        ::  /lib/lattice-share: claims, not capabilities). /shares.sig is the
        ::  inbox fiber that takes those pokes. The /public usergroup carries a
        ::  poke road for it (laid by +send-public-how) so ANY ship may notify,
        ::  which is safe because the list is capped and sender identity comes
        ::  from the transport.
            [%fall %& [/ %shared] [[/lattice %shared] *shared:ls]]
            [%fall %& [/ %'shares.sig'] [[/ %sig] ~]]
        ::  /comments.sig: the cross-ship COMMENT inbox. Same shape as
        ::  shares.sig and the same reasoning: /public carries a poke road for
        ::  it (laid by +send-public-how) so any ship running lattice may append,
        ::  and the author is taken from the transport rather than the payload.
        ::  The road reaches only this fiber, and this fiber writes only under
        ::  /comments, so a commenter structurally cannot touch a page.
            [%fall %& [/ %'comments.sig'] [[/ %sig] ~]]
        ::  /fs.sig: a lick (unix-socket) port exposing the filesystem ops to a
        ::  local FUSE client (lattice-fs), the native-transport twin of the
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
        =/  root=@ud  (lent path.rail)
        ::  lay lattice's COMPLETE public grant set through the registry's
        ::  %how action: /pub for foreign readers, every shared page's data
        ::  road, and the share/comment inboxes. One act, server-side merged,
        ::  self-healing on every writer start. know/ needs nothing. Foreign
        ::  access is deny-by-default.
        ;<  ~  bind:m  (send-public-how root)
        ::  lay down the built-in page-tree templates (idempotent; skips if the
        ::  user already has them). Users instantiate a copy under /page.
        ;<  ~  bind:m  (ensure-shipped-templates root)
        |-
        ;<  =sage:tarball  bind:m  take-poke:io
        ;<  now=@da  bind:m  bowl-now
        ;<  ~  bind:m  (apply-action root now sage)
        ::  bump the change beacon so open readers live-reload (see +bump-rev).
        ::
        ::  EXCEPT for history. Every page view records a visit, and bumping the
        ::  beacon on each one would make browsing live-reload every other open
        ::  reader, a reload storm produced by nothing the reader can see.
        ::  History is not content; it does not belong on the content beacon.
        ;<  ~  bind:m
          ?:  =([/lattice %history-action] p.sage)  (pure:m ~)
          (bump-rev now)
        $
      ::  /shares.sig: the cross-ship share-notice inbox. Foreign ships %add.
      ::  Only our own UI may %del (sender is read from the TRANSPORT, so a
      ::  forged payload cannot curate our list). Same take-poke loop shape as
      ::  the writer below.
          [~ %'shares.sig']
        ;<  ~  bind:m  (rise-wait:io prod "%lattice /shares: failed")
        ::  root is NOT ambient in on-file. Each case that needs it derives it
        ::  from its own rail, exactly as the writer above does.
        =/  root=@ud  (lent path.rail)
        |-
        ;<  [=from:fiber:nexus =sage:tarball]  bind:m  take-poke-from:io
        ;<  now=@da  bind:m  bowl-now
        ;<  ~  bind:m  (apply-share-notice root from sage now)
        $
      ::  /comments.sig: the cross-ship comment inbox. Foreign ships poke a
      ::  comment-action; we take the author from the TRANSPORT, never from the
      ::  payload, so it cannot be forged. Same take-poke loop as /shares.sig.
          [~ %'comments.sig']
        ;<  ~  bind:m  (rise-wait:io prod "%lattice /comments: failed")
        =/  root=@ud  (lent path.rail)
        |-
        ;<  [=from:fiber:nexus =sage:tarball]  bind:m  take-poke-from:io
        ;<  now=@da  bind:m  bowl-now
        ;<  ~  bind:m  (apply-comment-notice root from sage now)
        $
      ::  /ui/main.sig: bind the HTTP endpoint and dispatch each request into a
      ::  per-request fiber under /ui/requests (same pattern as counter).
          [[%ui ~] %'main.sig']
        ;<  ~  bind:m  (rise-wait:io prod "%lattice /ui/main: failed")
        ;<  ~  bind:m  (bind-http-self:io [~ /apps/lattice])
        (http-dispatch:io %lattice)
      ::  /ui/requests/*: one ephemeral fiber per in-flight HTTP request.
          [[%ui %requests ~] @]
        ;<  ~  bind:m  (rise-wait:io prod "%lattice /ui/requests: failed")
        (handle-request (lent path.rail) name.rail)
      ::  /sub/pages/*: one live per-file subscription. keep the peer's page grub
      ::  and act on every wave, so an edit is noticed as it happens. The body
      ::  arrives entirely over the namespace: %keen
      ::  at the concrete rev the wave names, with NO peek fallback. This reader
      ::  is mesa-only by design, so a non-mirroring publisher's waves keen an
      ::  unbound spur and index nothing (one bounded retry per wave, then wait
      ::  for the next wave). The keep is re-established from the stored
      ::  page-sub on reload. Culling the grub (via /unsub) tears down the
      ::  fiber and its keep (delete -> sub-wipe).
          [[%sub %pages ~] @]
        ;<  ~  bind:m  (rise-wait:io prod "%lattice /sub/pages: failed")
        ;<  ps=page-sub:lp  bind:m  (get-state-as:io ,page-sub:lp)
        =/  rel=path  (page-rel pax.ps)
        ::  Keep the peer's page gmi FILE, the node apply-pub GAINS, so a keep
        ::  on it gets a %news on every edit. Keeping the parent dir would
        ::  subscribe to an un-gained node and never fire.
        ::
        ::  mesa (D2): the reader rides this ONE keep and nothing else. The
        ::  keep's wave carries the gmi grub's cass, on the initial bond
        ::  (grubbery answers a new watcher with +wave-at, the live state, cass
        ::  and all) AND on every edit. That cass IS the vault rev the
        ::  publisher last grew a binding at (+pub-grub-rev / +grow-pub-page /
        ::  the %del tombstone). So the wave alone teaches the rev and we keen
        ::  at it. No pointer, no seq bookkeeping. The wave is the whole
        ::  rev-discovery channel.
        =/  road=road:tarball
          (remote-road [%& %& (weld (weld app-base:lu /pub/vault) rel) %gmi] ship.ps)
        ::  keep:io RETURNS the bond wave (grubbery answers a new watcher with
        ::  +wave-at, the live state). Feed it through the same wave handler as
        ::  an edit wave, so a fresh subscription indexes NOW instead of at the
        ::  publisher's next edit, and a rebooted reader catches up on whatever
        ::  it missed while down.
        ;<  bond=wave:nexus  bind:m  (keep:io /page road ~)
        ::  lrev: the last vault rev this fiber acted on (0 = nothing yet).
        ;<  lrev=@ud  bind:m  (sub-apply-wave ship.ps rel bond 0)
        |-
        ::  take-sub-wave-drain, not take-news. A timed-out keen's late
        ::  %keen-response poke and a stray %veto still arrive at this
        ::  long-lived fiber, and plain take-news would %skip them and pile
        ::  them in the skip queue forever. -drain consumes them. A %wake is
        ::  just drained. Only a real %news works.
        ;<  nw=sub-wave  bind:m  take-sub-wave-drain
        ?-  -.nw
            %wake  $
            %page
          ;<  nl=@ud  bind:m  (sub-apply-wave ship.ps rel wave.nw lrev)
          $(lrev nl)
        ==
      ::  /page/<name>/code: the page evaluator (docs/platform.md step 2). The
      ::  fiber owns the page's code grub: compile the source (a gate) against
      ::  the hoon stdlib, run it on commands (cmd grub, seq-bumped) and on
      ::  dependency waves, write the product to the data grub. A compile or
      ::  run crash writes err and keeps the last good data. A broken page
      ::  never kills the fiber (mule everything). ponytail: dep keeps are
      ::  armed and never dropped (a removed dep still ticks. save-file's
      ::  no-op suppression bounds it); page code gets the hoon stdlib only
      ::  (..add) and returns NO darts yet. The capped-authority %sand
      ::  plumbing lands with darts (platform decision). A divergent dep
      ::  cycle spins. A converging one terminates via no-op suppression.
          [[%page @ *] %code]
        ;<  ~  bind:m  (rise-wait:io prod "%lattice /page eval: failed")
        ::  this fiber IS the page dir: on-file hands it a rail already
        ::  relativised to the nexus, so its path is /page/<name> and its
        ::  length is the climb back to the root.
        =/  up=@ud  (lent path.rail)
        =/  pdir=path  path.rail
        ::  one wire for everything: code (self), cmd inbox, deps grub, and
        ::  each declared dep target. Any change wakes the loop.
        ;<  *  bind:m  (keep:io /ev (rf up pdir %code) ~)
        ;<  *  bind:m  (keep:io /ev (rf up pdir %cmd) ~)
        ;<  *  bind:m  (keep:io /ev (rf up pdir %deps) ~)
        ::  `last` = last-PROCESSED cmd seq, persisted in the /seen grub (NOT
        ::  inferred from the current cmd grub). A page-save on a compile-broken
        ::  page respawns this fiber (put-file over /code), which re-inits `last`
        ::  from /seen, so a command sent while broken (seq past /seen) still
        ::  runs once the fix compiles, while a plain reload never replays an
        ::  already-run command (both caught by review).
        ;<  last=@ud  bind:m  (read-eval-seen pdir)
        =/  armed=(set path)  ~
        =/  held=@t  '=='
        =/  bild=(each vase tang)  [%| `tang`~[leaf+"not compiled"]]
        ::  gen counts RAPID consecutive dep-tick reruns. A dep cycle or an
        ::  always-changing page reruns as fast as the event loop allows and
        ::  would livelock it. A legit reactive page reruns only when an
        ::  upstream actually changes, spaced out in time. So gen accumulates
        ::  only while reruns land closer together than `rerun-gap`, and resets
        ::  on a command or a slow (legit) gap, capping runaways without ever
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
            (put-file (rf up pdir %err) [/lattice %page] (render-tang 'compile failed:' p.bild))
          ;<  *  bind:m  (take-news-or-wake-drain /ev)
          $
        ;<  deps=(list path)  bind:m  (read-eval-deps pdir)
        ;<  na=(set path)  bind:m  (arm-eval-deps armed deps)
        =.  armed  na
        ;<  cur=eval-cmd:le  bind:m  (read-eval-cmd pdir)
        =/  fresh=?  (gth seq.cur last)
        ;<  now=@da  bind:m  bowl-now
        ::  rapid = this rerun landed within `rerun-gap` of the previous one (a
        ::  runaway burst: a DEPENDENCY cycle or an always-changing page reruns
        ::  as fast as the loop allows). gen accumulates while rapid and resets
        ::  on a settled gap. (Page-to-page POKE cycles are too slow per hop for
        ::  this window. Those are bounded by the poke budget instead.)
        =/  rapid=?  &(!=(`@da`0 last-now) (lth (sub now last-now) rerun-gap))
        =.  gen  ?:(rapid +(gen) 0)
        =.  last-now  now
        ?:  (gth gen recompute-cap)
          ::  a sustained rapid rerun burst: a cycle or an always-changing page.
          ::  Stop producing data (that is what wakes our dependents), write err,
          ::  and park until a command (or a settled gap) resets gen.
          =/  msg=@t
            'recompute limit hit (dependency cycle or always-changing page?); edit and save to resume'
          ;<  ~  bind:m  (put-file (rf up pdir %err) [/lattice %page] msg)
          ;<  *  bind:m  (take-news-or-wake-drain /ev)
          $
        =/  cmd=(unit @t)  ?:(fresh `txt.cur ~)
        ::  poke budget for this run: a command carries one (a page reached via
        ::  a poke got a decremented budget). A dep/timer tick starts fresh.
        =/  run-bud=@ud  ?:(fresh bud.cur poke-budget-max)
        ;<  ~  bind:m  (eval-run pdir p.bild cmd deps run-bud)
        ::  eval-run recorded any timer request in the /wake grub (clamped, or ~
        ::  if the page asked for no timer or its run failed). Read it back.
        ;<  wake=(unit @dr)  bind:m  (read-wake pdir)
        ::  persist the processed seq only when a command actually ran (a dep
        ::  tick leaves seq unchanged). /seen is not kept, so this fires no wave.
        =?  last  fresh  seq.cur
        ;<  ~  bind:m  ?:(fresh (write-eval-seen pdir seq.cur) (pure:m ~))
        ::  wait for a dependency/command wave, or, if the page asked for a
        ::  timer (`every`), for that timer, whichever comes first. Using
        ::  -until keyed on this timer means an earlier stale timer is drained,
        ::  so timers don't pile up across reruns.
        ?~  wake
          ;<  *  bind:m  (take-news-or-wake-drain /ev)
          $
        ::  anchor the timer to a FRESH now, read AFTER eval-run. The `now` above
        ::  was captured before the (possibly slow) run. If the run took longer
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
      ::  /fs.sig: the lick (local IPC) port for the FUSE client. The serve-loop
      ::  is generic. +lick-serve:io (fiberio) spins the socket, decodes each
      ::  [verb path query body] frame, and spits back [status body]. The only
      ::  lattice-specific part is the +fs-op handler. Auth is filesystem-presence.
      ::  The socket lives in the pier.
          [~ %'fs.sig']
        ;<  ~  bind:m  (rise-wait:io prod "%lattice fs port: failed")
        (lick-serve:io fs-port fs-op)
      ::  /mirror/mirror.sig: the commons reconciler (docs/obelisk-mirror.md
      ::  section 5). The loop lives in +mirror-loop.
          [[%mirror ~] %'mirror.sig']
        ;<  ~  bind:m  (rise-wait:io prod "%lattice mirror: failed")
        ;<  ~  bind:m  (mirror-trace %reconciler-started)
        mirror-loop
      ==
    --
|%
::  +srv: HTTP response door, the road from a /ui/requests/* fiber up to
::  /ui/main.sig, through which all responses are sent (so the dispatcher can
::  cancel orphaned connections). Identical layout to counter.
::
++  srv  ~(. http-res:io [%| 1 %& ~ %'main.sig'])
::  +handle-page-save-batch: POST /page-save-batch. One %make-many transaction
::  for a whole upload or queue replay. ?report=1 switches to REPLAY mode, where
::  each item also carries the rev it was made from and the response reports
::  {rev, conflicted} per item instead of a bare count. The plain mode wants
::  all-or-nothing and no per-item bookkeeping, which is why it is a mode rather
::  than the default.
::
++  handle-page-save-batch
  |=  [eyre-id=@ta req=inbound-request:eyre args=(map @t @t)]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  =/  jon=(unit json)  (de:json:html (req-body req))
  ?~  jon  (send-err eyre-id 400 'bad json')
  ::  ?report=1: REPLAY mode. Items additionally carry base (the rev each
  ::  queued edit was made from) and the response reports per-item
  ::  {rev, conflicted} instead of a bare count. A mode rather than the
  ::  default because the upload path WANTS all-or-nothing and no per-item
  ::  bookkeeping. The write itself is unchanged either way: one %make-many
  ::  transaction.
  =/  report=?  =('1' (~(gut by args) 'report' '0'))
  =/  pr=(each (list [nam=@t typ=@t bod=@t bas=@ud]) tang)
    %-  mule  |.
    %.  u.jon
    %-  ar:dejs:format
    ?:  report
      %-  ot:dejs:format
      :~  name+so:dejs:format
          type+so:dejs:format
          body+so:dejs:format
          base+ni:dejs:format
      ==
    |=  j=json
    ^-  [@t @t @t @ud]
    =/  [nam=@t typ=@t bod=@t]
      %.  j
      %-  ot:dejs:format
      :~  name+so:dejs:format
          type+so:dejs:format
          body+so:dejs:format
      ==
    [nam typ bod 0]
  ?:  ?=(%| -.pr)
    %+  send-err  eyre-id
    [400 ?:(report 'expected [{name, type, body, base}]' 'expected [{name, type, body}]')]
  =/  items=(list [nam=@t typ=@t bod=@t bas=@ud])  p.pr
  ?:  =(0 (lent items))  (send-err eyre-id 400 'empty batch')
  ::  bounded: one transaction the writer cannot be talked into running
  ::  forever. The client chunks above this.
  ?:  (gth (lent items) 200)  (send-err eyre-id 400 'batch too large (max 200)')
  ?.  (levy items |=([nam=@t *] (valid-name nam)))
    (send-err eyre-id 400 'bad page name in batch')
  =/  pages=(list [pax=path src=@t])
    %+  turn  items
    |=  [nam=@t typ=@t bod=@t bas=@ud]
    =/  ptype=@tas  `@tas`typ
    :-  (pax-of nam)
    ?:  =(%index ptype)  (make-folder-index (pax-of nam))
    ?:  (~(has in content-builders) ptype)  (wrap-content ptype bod)
    bod
  ::  report mode: read every page's rev BEFORE the write (conflict = the
  ::  ship moved past the base the edit was made from) and after (the new
  ::  rev the client should carry forward). Same caveat as page-save: the
  ::  compare is fiber-adjacent to the poke, so a same-ship interleave can
  ::  mislabel a flag, never lose a revision.
  ;<  prevs=(list @ud)  bind:m
    =/  n  (fiber:fiber:nexus ,(list @ud))
    ?.  report  (pure:n ~)
    =/  todo=(list [nam=@t typ=@t bod=@t bas=@ud])  items
    =|  acc=(list @ud)
    |-  ^-  form:n
    ?~  todo  (pure:n (flop acc))
    ;<  r=@ud  bind:n  (page-rev (pax-of nam.i.todo))
    $(todo t.todo, acc [r acc])
  ::  conflicted items get their losing body preserved FIRST, in the same
  ::  %make-many transaction. See +conflict-name for why history is not
  ::  enough. Peeks happen here (fiber), the writes land atomically below.
  ::  dups: items whose stale base points at content IDENTICAL to what the
  ::  ship already holds, a replay racing its own timed-out-but-landed
  ::  write. Not a conflict (see page-save). Aligned with items for the
  ::  report below.
  ;<  kd=[keeps=(list [pax=path src=@t]) dups=(list ?)]  bind:m
    =/  n  (fiber:fiber:nexus ,[keeps=(list [pax=path src=@t]) dups=(list ?)])
    ?.  report  (pure:n [~ ~])
    =/  todo=(list [nam=@t typ=@t bod=@t bas=@ud])  items
    =/  ps=(list @ud)  prevs
    =/  pg=(list [pax=path src=@t])  pages
    =|  keeps=(list [pax=path src=@t])
    =|  dups=(list ?)
    |-  ^-  form:n
    ?~  todo  (pure:n [(flop keeps) (flop dups)])
    =/  pv=@ud  ?~(ps 0 i.ps)
    =/  more  ?~(ps ~ t.ps)
    =/  wsrc=@t  ?~(pg '' src.i.pg)
    =/  pgm  ?~(pg ~ t.pg)
    ::  base 0 = NO base claim (a save rebased by an offline move cannot
    ::  know the destination's rev): apply without a conflict check.
    ?.  &(!=(0 bas.i.todo) !=(bas.i.todo pv))
      $(todo t.todo, ps more, pg pgm, dups [| dups])
    ;<  old=(unit @t)  bind:n  (page-src (pax-of nam.i.todo))
    ::  missing page or identical body: stale base, but nothing to preserve
    ::  and nothing to disagree with. Not a conflict
    ?~  old  $(todo t.todo, ps more, pg pgm, dups [& dups])
    ?:  =(u.old wsrc)  $(todo t.todo, ps more, pg pgm, dups [& dups])
    %=  $
      todo   t.todo
      ps     more
      pg     pgm
      dups   [| dups]
      keeps  [[(pax-of (conflict-name nam.i.todo pv)) u.old] keeps]
    ==
  =/  keeps=(list [pax=path src=@t])  keeps.kd
  ;<  ~  bind:m  (poke-eval [%make-many (weld keeps pages)])
  ?.  report
    %+  send-json  eyre-id
    (pairs:enjs:format ~[['ok' b+&] ['saved' (numb:enjs:format (lent items))]])
  ::  new rev per item = prev+1, computed for the same reason page-save
  ::  computes it. A same-fiber peek cannot observe the write it follows
  =/  out=(list json)
    =/  todo  items
    =/  ps  prevs
    =/  ds  dups.kd
    =|  acc=(list json)
    |-  ^-  (list json)
    ?~  todo  (flop acc)
    =/  pv=@ud  ?~(ps 0 i.ps)
    =/  nw=@ud  +(pv)
    =/  cf=?  &(!=(0 bas.i.todo) !=(bas.i.todo pv) ?~(ds & !i.ds))
    %=  $
      todo  t.todo
      ps    ?~(ps ~ t.ps)
      ds    ?~(ds ~ t.ds)
      acc
    :_  acc
    %-  pairs:enjs:format
    :~  ['name' s+nam.i.todo]
        ['rev' (numb:enjs:format nw)]
        ['prev-rev' (numb:enjs:format pv)]
        ['conflicted' b+cf]
        ['kept' s+?.(cf '' (conflict-name nam.i.todo pv))]
    ==
    ==
  %+  send-json  eyre-id
  %-  pairs:enjs:format
  :~  ['ok' b+&]
      ['saved' (numb:enjs:format (lent items))]
      ['items' a+out]
  ==
::  +save-src: the front half of the page-save contract, shared so the two write
::  surfaces cannot drift on what a valid save is. POST /page-save and the lick
::  %page-save both start here: name validation, the body rule, and the two
::  errors they produce, then the source the page is stored as.
::
::  ?type=index: no body. The code is generated from the page's own path (it
::  lists its own folder). Otherwise a body is required. ?type=<builder>: the
::  body is raw content, not hoon, so it is wrapped in `... (BUILDER 'body')`
::  and the whole pipeline runs unchanged. edit reopens it via unwrap-content.
::  Absent/unknown type -> raw hoon.
::
++  save-src
  |=  [name=@t ptype=@tas raw=@t]
  ^-  (each @t [code=@ud msg=@t])
  ?.  (valid-name name)  [%| 400 'bad name']
  =/  is-index=?  =(%index ptype)
  ?:  &(?!(is-index) =('' raw))  [%| 400 'missing body']
  :-  %&
  ?:  is-index  (make-folder-index (pax-of name))
  ?:((~(has in content-builders) ptype) (wrap-content ptype raw) raw)
::  +handle-page-save: POST /page-save. One page, with the conflict rule the
::  offline queue depends on: ?base=<rev> claims the rev this edit was made
::  from, and a write against a moved-on page is reported as conflicted with
::  the replaced body kept, rather than refused or silently overwritten.
::
++  handle-page-save
  |=  [eyre-id=@ta req=inbound-request:eyre args=(map @t @t)]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  =/  name=(unit @t)  (~(get by args) 'name')
  ?~  name  (send-err eyre-id 400 'missing name')
  =/  ptype=@tas  `@tas`(~(gut by args) 'type' 'hoon')
  =/  sr  (save-src u.name ptype (req-body req))
  ?:  ?=(%| -.sr)  (send-err eyre-id code.p.sr msg.p.sr)
  =/  src=@t  p.sr
  ::  ?new=1: create-only, 409 instead of silently overwriting an existing
  ::  page (the editor's new-page mode sends it; caught by review). Only the
  ::  new=1 path pays the existence peek. A plain overwrite (every autosave)
  ::  never used the answer.
  ;<  ex=?  bind:m
    ?.  (~(has by args) 'new')  (pure:(fiber:fiber:nexus ,?) %.n)
    (peek-exists:io (rf up (weld /page (pax-of u.name)) %code))
  ?:  &((~(has by args) 'new') ex)  (send-err eyre-id 409 'page exists')
  ::  ?base=<rev>: the revision the caller edited FROM (the offline queue
  ::  stamps it at enqueue). Compared HERE rather than by the client. A
  ::  client check-then-write races anything landing in between. The compare
  ::  sits one fiber-bind from the poke, so a same-ship interleave can still
  ::  mislabel a conflict in principle. The consequence is only a wrong FLAG
  ::  (every save is a kept revision either way), which is why apply-and-flag
  ::  is safe where refuse-and-block would need true writer-side CAS.
  =/  base=(unit @ud)  (rush (~(gut by args) 'base' '') dim:ag)
  ;<  prev=@ud  bind:m  (page-rev (pax-of u.name))
  =/  stale=?  &(?=(^ base) !=(u.base 0) !=(u.base prev))
  ;<  old=(unit @t)  bind:m
    =/  n  (fiber:fiber:nexus ,(unit @t))
    ?.  stale  (pure:n ~)
    (page-src (pax-of u.name))
  ::  identical content cannot conflict. The client's 10s deadline can fire
  ::  on a request the pier nevertheless applies (abort stops the WAIT, not
  ::  the write), so the queued replay carries a base one rev behind its own
  ::  landed save: same body, moved rev. Flagging that manufactured a bogus
  ::  conflicts/ page holding a copy of the very body being saved. A missing
  ::  page is the same shape: nothing to preserve, nothing to conflict with.
  =/  conflicted=?  &(stale ?=(^ old) !=(u.old src))
  =/  kept=@t  ?.(conflicted '' (conflict-name u.name prev))
  ;<  ~  bind:m
    =/  n  (fiber:fiber:nexus ,~)
    ?.  conflicted  (pure:n ~)
    ?~  old  (pure:n ~)
    (poke-eval [%make (pax-of kept) u.old])
  ;<  ~  bind:m  (poke-eval [%make (pax-of u.name) src])
  ::  ?dname= / ?dnames=: display names (see +dname-acts-of), sent by the
  ::  client only when the typed name was not a valid path and the path is
  ::  its slug. Absent on every ordinary save, so autosave never touches them.
  ;<  ~  bind:m  (poke-dnames args (pax-of u.name))
  ::  the new rev is prev+1, COMPUTED not re-peeked. A peek in this same
  ::  fiber does not observe the write yet (effects flush on yield), so a
  ::  post-write peek returned the stale rev, and a client carrying that
  ::  as its base would flag a false conflict on every second save. %make
  ::  commits the code grub exactly once, so +1 is exact.
  ::  additive over the old {"ok":true}. Nothing keyed on the exact shape
  %+  send-json  eyre-id
  %-  pairs:enjs:format
  :~  ['ok' b+&]
      ['rev' (numb:enjs:format +(prev))]
      ['prev-rev' (numb:enjs:format prev)]
      ['conflicted' b+conflicted]
      ['kept' s+kept]
  ==
::  +handle-share-group-save: POST /share-group-save. Write one usergroup's
::  members and the weir that grants them access. A group naming a banned ship
::  is refused outright rather than written with that ship dropped, because a
::  silent drop reads as a grant that was made and was not.
::
++  handle-share-group-save
  |=  [eyre-id=@ta req=inbound-request:eyre args=(map @t @t)]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  =/  gname=(unit @t)  (~(get by args) 'name')
  ?~  gname  (send-err eyre-id 400 'missing name')
  ?.  ((sane %tas) u.gname)
    (send-err eyre-id 400 'group name: lowercase letters, digits, hyphens')
  =/  jon=(unit json)  (de:json:html (req-body req))
  ?~  jon  (send-err eyre-id 400 'bad json')
  =/  pr=(each [ships=(list @t) peek=(list @t) make=(list @t)] tang)
    %-  mule  |.
    %.  u.jon
    %-  ot:dejs:format
    :~  ships+(ar:dejs:format so:dejs:format)
        peek+(ar:dejs:format so:dejs:format)
        make+(ar:dejs:format so:dejs:format)
    ==
  ?:  ?=(%| -.pr)  (send-err eyre-id 400 'expected {ships, peek, make}')
  =/  ships=(list (unit @p))  (turn ships.p.pr |=(t=@t (slaw %p t)))
  ?:  (lien ships |=(u=(unit @p) ?=(~ u)))
    ::  a typo'd ship silently dropped = someone believes they granted
    ::  access and did not. Reject the whole save instead.
    (send-err eyre-id 400 'bad ship name in list')
  =/  parse-paths
    |=  ts=(list @t)
    ^-  (unit (list path))
    =|  out=(list path)
    |-  ^-  (unit (list path))
    ?~  ts  `(flop out)
    =/  pp=(each path tang)  (mule |.((stab i.ts)))
    ?:  ?=(%| -.pp)  ~
    ::  grants stay under /apps. A peek grant on /sys leaks ACLs and silo
    ::  internals. A make grant there lets a peer edit your usergroups. The
    ::  dojo can still do it deliberately. This editor will not do it by
    ::  accident.
    ?.  ?=([%apps *] p.pp)  ~
    $(ts t.ts, out [p.pp out])
  =/  pkp=(unit (list path))  (parse-paths peek.p.pr)
  =/  mkp=(unit (list path))  (parse-paths make.p.pr)
  ?:  |(?=(~ pkp) ?=(~ mkp))
    (send-err eyre-id 400 'grant paths must be absolute and under /apps')
  =/  gdir=path  (snoc ug-base (crip (weld (trip u.gname) ".grp")))
  ;<  old=weir:nexus  bind:m  (ug-read-weir gdir)
  ::  OPEN: these are weir roads granted to OTHER ships, built from paths
  ::  the request supplied. Whether they should be absolute (as a grantee
  ::  addresses them, which needs our own path) or relative (as the
  ::  registry resolves them against our registered rail) is a question
  ::  about the sharing model, not a rename - so they are left as they
  ::  were. +send-public-how's grants went relative; if that proves right
  ::  these follow it.
  =/  to-roads
    |=  ps=(list path)
    ^-  (set road:tarball)
    (~(gas in *(set road:tarball)) (turn ps |=(p=path [%& %| p])))
  =/  =weir:nexus
    :+  (~(uni in (ug-keep make.old)) (to-roads u.mkp))
      poke.old
    (~(uni in (ug-keep peek.old)) (to-roads u.pkp))
  ;<  bans=banned:ls  bind:m  read-banned
  =/  who=(set @p)  (~(gas in *(set @p)) (murn ships same))
  ::  a group save must not smuggle a banned ship back in. Reject rather than
  ::  silently drop. A silently-dropped ship is someone believing they granted
  ::  access and did not, which is this editor's worst failure mode.
  ?:  (lien ~(tap in who) |=(w=@p (is-banned:ls bans w)))
    (send-err eyre-id 403 'that group names a banned ship')
  ;<  ~  bind:m  (over:io [%& %& gdir %'who.ships'] [[/ %ships] who])
  ;<  ~  bind:m  (over:io [%& %& gdir %'how.weir'] [[/ %weir] weir])
  (send-ok eyre-id)
::  +handle-remote-save: POST /remote-save. Write a grub onto ANOTHER ship's
::  grubbery, which is why it takes `our`: saving to yourself is a different
::  path (/grub-save) and is refused here rather than silently rerouted.
::
++  handle-remote-save
  |=  [eyre-id=@ta req=inbound-request:eyre args=(map @t @t) our=@p]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  =/  shp-t=(unit @t)  (~(get by args) 'ship')
  ?~  shp-t  (send-err eyre-id 400 'missing ship')
  =/  shp=(unit @p)  (slaw %p u.shp-t)
  ?~  shp  (send-err eyre-id 400 'bad ship')
  ?:  =(u.shp our)  (send-err eyre-id 400 'own ship: use /grub-save')
  =/  pt=(unit @t)  (~(get by args) 'path')
  ?~  pt  (send-err eyre-id 400 'missing path')
  =/  pp=(each path tang)  (mule |.((stab u.pt)))
  ?:  ?=(%| -.pp)  (send-err eyre-id 400 'bad path')
  ?:  =(~ p.pp)  (send-err eyre-id 400 'empty path')
  =/  n=@ud  (dec (lent p.pp))
  =/  dir=path  (scag n p.pp)
  =/  nam=@ta  (snag n p.pp)
  =/  body=@t  (req-body req)
  =/  file-road=road:tarball  [%& %& dir nam]
  ;<  ms=(unit view:nexus)  bind:m  (peek-remote-wait file-road u.shp)
  ?~  ms  (send-err eyre-id 504 'unreachable or denied')
  ::  v1 edits EXISTING files only. Remote create needs a make grant plus a
  ::  blot decision the client can't make for a tree it doesn't own.
  ?.  ?=([%file *] u.ms)  (send-err eyre-id 404 'no such file on that ship')
  ?:  =((grub-text sang.u.ms) `body)
    ::  no-op save: nothing to send, and grubbery skips unchanged writes
    ::  anyway, so the revision check below would misread it as a denial.
    (send-ok eyre-id)
  =/  ud0=@ud  ud.cass.u.ms
  ::  rebuild the noun in the grub's OWN shape (cord / wain / mime) and send
  ::  it under its OWN blot, with NO destination conversion. Converting
  ::  mime->blot at the destination needs the target marc to carry a mime
  ::  grab, and lattice's own %page marc doesn't. A missing tube drops the
  ::  make SILENTLY on their side (found live: the save 403'd on the
  ::  revision check while a blot-converted remote_over "landed" an empty
  ::  body). Shape-preserving nouns need no tube; their marc just re-clams.
  =/  dst=blot:tarball  p.sang.u.ms
  =/  nn=*  (sang-noun:tarball sang.u.ms)
  ?:  &(?=(~ (mole |.(;;(@t nn)))) ?=(~ (mole |.(;;(wain nn)))) !=([/ %mime] dst))
    (send-err eyre-id 415 'grub shape not editable as text')
  =/  bd=[b=bask:tarball d=(unit blot:tarball)]
    ?:  ?=(^ (mole |.(;;(@t nn))))
      [[dst `*`body] ~]
    ?:  ?=(^ (mole |.(;;(wain nn))))
      [[dst `*`(to-wain:format body)] ~]
    =/  mt=path  (fall (grub-mime-type sang.u.ms) /text/plain)
    [[[/ %mime] `*``mime`[mt (as-octs:mimes:html body)]] ~]
  ;<  nak=(unit tang)  bind:m
    (remote-load-poke u.shp [[/remote-save %& dir nam] %make %.y %.n |+[b.bd d.bd]])
  ?^  nak
    (send-err eyre-id 502 'remote rejected the write')
  ;<  vs=(unit view:nexus)  bind:m  (peek-remote-wait file-road u.shp)
  =/  landed=?
    ?~  vs  |
    ?.  ?=([%file *] u.vs)  |
    (gth ud.cass.u.vs ud0)
  ?.  landed
    (send-err eyre-id 403 'write did not land — no make permission on that path?')
  (send-ok eyre-id)
::  +handle-legacy-migrate: POST /legacy-migrate. Import the pages and memories
::  of a retired %lattice gall agent, once. It takes only eyre-id because it
::  reads everything it needs from the old agent rather than the request, and
::  it writes a marker so a re-run is harmless.
::
++  handle-legacy-migrate
  |=  eyre-id=@ta
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ;<  done=?  bind:m  legacy-resolved
  ?:  done  (send-err eyre-id 409 'already resolved')
  ;<  up=?  bind:m  legacy-live
  ?.  up  (send-err eyre-id 404 'no legacy agent')
  ;<  aj=json  bind:m  (legacy-peek /gx/lattice/know/all/json)
  =/  parsed=(each (list [@t know-entry:lk]) tang)  (mule |.((parse-import aj)))
  ?:  ?=(%| -.parsed)  (send-err eyre-id 502 'bad legacy export shape')
  ::  FAIL CLOSED. +read-know-map maps ANY unreadable view onto the empty
  ::  map, which is indistinguishable from a legitimately empty store, and
  ::  "empty" would mean every legacy entry imports over live data. Use the
  ::  unit-returning read so a genuine read FAILURE refuses the import, while
  ::  a real (readable) empty store still migrates normally.
  ;<  esu=(unit (map path know-entry:lk))  bind:m  read-know-vault-safe
  ?~  esu  (send-err eyre-id 503 'local store unreadable; import refused')
  =/  es=(map path know-entry:lk)  u.esu
  ::  skip anything we already hold LIVE or in TRASH. Importing over a
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
  ::  its page list at all. Treat that as UNKNOWN, never as "no pages", or
  ::  the completion dialog would clear an agent that still holds the only
  ::  copy of them.
  ;<  prels=(unit (list path))  bind:m  legacy-page-rels
  =/  want=(list path)  ?~(prels ~ u.prels)
  ::  never let a legacy body land on a page we already have. %save-page is
  ::  an unconditional upsert in the writer, so a name collision would
  ::  overwrite the user's own published body. Drop collisions before
  ::  triggering and report them as left-behind.
  ;<  live-pages=(list path)  bind:m  (page-sources-present want)
  ::  A legacy name can also collide with a page this nexus published but
  ::  never had a source for (POST /save, know-publish). %save-page is an
  ::  unconditional upsert, so triggering would overwrite the user's body.
  ::  Anything ALREADY in the vault is therefore off limits, unless a prior
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
  ::  window in which arrivals can be missed. What we read is what we write.
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
  ::  user can retry. The knowledge import is idempotent (skip-existing),
  ::  so a retry costs nothing and finishes the pages.
  =/  page-total=@ud  (lent want)
  ::  "complete" means: we could read the page list, and every page we were
  ::  allowed to move actually landed AND was promoted. Collisions count as
  ::  NOT complete. Those pages stay only in the old agent, so the agent
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
      ::  why the trigger failed, when it did, the difference between
      ::  "no pages arrived" and knowing the poke was refused
      :-  'pageError'
      ?~  bodies  s+'could not read the old agent\'s pages'
      ~
      ['pagesKnown' b+?=(^ prels)]
      ['complete' b+done]
  ==
::  +handle-request: serve one HTTP request. Owner-auth first, then the two
::  unauthenticated surfaces (clearweb reads and public form posts), then the
::  route table below, which dispatches on [method (rear suffix)]. The five
::  largest handlers live in their own arms above; every other route answers
::  inline here so the whole contract stays readable in one place.
::
::  takes the depth rather than asking for it. +nexus-up is a dart and a
::  wait, and a request fiber's FIRST act has to be reading its own state -
::  interposing a round trip before that left the request grub unread and
::  every HTTP request hanging. The dispatch arm holds the rail, so the
::  depth costs nothing there.
++  handle-request
  |=  [up=@ud eyre-id=@ta]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ;<  [src=@p req=inbound-request:eyre]  bind:m
    (get-state-as:io ,[src=@p inbound-request:eyre])
  =/  parsed  (parse-url:http-utils url.request.req)
  ::  drop the /apps/lattice prefix; the remainder is the route.
  =/  suffix=path  (slag 2 site.parsed)
  ::  a trailing '/' parses as a trailing empty knot, the same shape +explore
  ::  already trims for its own path argument (see there). Drop it here too, so
  ::  /apps/lattice/ dispatches exactly like /apps/lattice instead of falling
  ::  through every route below to the generic 404.
  =/  suffix=path
    |-  ^-  path
    ?:  &(?=(^ suffix) =('' (rear `path`suffix)))
      $(suffix (snip `path`suffix))
    suffix
  =/  args=(map @t @t)  (malt args.parsed)
  ::  clearweb: the ONLY unauthenticated surface. GET /c/<name> serves a
  ::  clearweb-tagged page's DATA, read-only: no tree nav, no code, no
  ::  sibling grubs, no command form. Everything else requires the owner.
  ?:  &(?=([%c ^] suffix) =(%'GET' method.request.req))
    (serve-clearweb eyre-id t.suffix authenticated.req)
  ::  public form submissions: POST /f/<page>. The ONLY unauthenticated WRITE,
  ::  and it is opt-in twice over. The page must be %clearweb AND carry a
  ::  /forms-on flag (owner-set). The body becomes one command to that page,
  ::  with poke budget 0 so a submission can never start a poke chain. The
  ::  gate is +serve-form; nothing else public can write.
  ?:  &(?=([%f ^] suffix) =(%'POST' method.request.req))
    (serve-form eyre-id t.suffix (req-body req))
  ::  PWA assets: also unauthenticated. Browsers fetch the manifest and the
  ::  apple-touch-icon WITHOUT credentials (only Chrome honors
  ::  crossorigin=use-credentials, iOS never sends cookies for icons). Behind
  ::  the owner gate they 403 and the install silently degrades to a bookmark
  ::  with no standalone display. Nothing here is private: the app's name,
  ::  colors, icons, and a generic caching worker.
  ?:  &(=(%'GET' method.request.req) =(`path`[%'manifest.webmanifest' ~] suffix))
    (send-typed eyre-id 'application/manifest+json' 'public, max-age=86400' manifest-json)
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
  ::  check. Reading `our` via a /sys/bowl round trip (bowl-our) just to compare
  ::  cost ~0.2s on EVERY request. Gate on the flag. `our` is then simply `src`.
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
    (serve-asset eyre-id t.suffix (~(has by args) 'preview'))
  ::  /know[/<key…>]: the private knowledge view. Browse the memory store in
  ::  the reader. Owner-only like every non-clearweb route (gated above).
  ?:  &(?=([%know *] suffix) =(%'GET' method.request.req))
    (serve-know eyre-id t.suffix args)
  ::  /app[/asset]: the lattice-hosted UI (grub-served; see ui-app/).
  ?:  &(?=([%app *] suffix) =(%'GET' method.request.req))
    (serve-ui eyre-id t.suffix)
  ::  root: the web reader (Landscape tile). ?url=urb://ship/rel renders that
  ::  page. No url renders the home index of our published pages. ponytail:
  ::  compact gemtext->HTML (headings/links/quotes/lists/pre). The full reader's
  ::  link-resolution + bookmark sync can follow.
  ?~  suffix
    =/  raw=(unit @t)  (~(get by args) 'url')
    ?~  raw
      ::  authored home first: if the user published an /index page, serve it,
      ::  else the generated listing. Both keep /pub/index so a publish/delete/
      ::  edit auto-refreshes the open reader.
      ;<  home=(unit @t)  bind:m  (read-page-body our our /index)
      ;<  rv=tape  bind:m  beacon-rev-tape
      ?~  home
        ;<  recent=(list [pax=path prev=@t])  bind:m  (read-recent 10)
        ;<  bms=bookmarks:lb  bind:m  read-bookmarks
        ;<  kes=(map path know-entry:lk)  bind:m  read-know-map
        (send-view-long eyre-id (render-page (weld "urb://" (scow %p our)) (keep-url "beacon/rev") rv (home-index-html our recent bms (know-quick-html:lkv kes 6))))
      =/  ttl=tape  (trip (page-title-of u.home 'lattice'))
      %+  send-view-long  eyre-id
      (render-page-titled (weld "urb://" (scow %p our)) (keep-url "beacon/rev") rv ttl (render-gmi u.home))
    =/  ref=(unit referent:lu)  (de-urb:lu u.raw)
    ::  omnibar: input that isn't a urb:// address is a SEARCH query. Serve a
    ::  results page that queries the term index (client-side, via the
    ::  /content-search JSON api, which is built for exactly this fan-out).
    ?~  ref  (send-view eyre-id (render-page-titled (trip u.raw) "" "" (trip u.raw) (search-results-html u.raw our)))
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
        (send-view eyre-id (render-page canon "" "" "<p class=\"err\">not published here</p>"))
      ::  own pages get a live reader (keep /pub/index: its per-page hash changes
      ::  on every edit). Remote pages stay static (can't keep a peer's grub).
      =/  rk=tape  ?:(=(ship.u.ref our) (keep-url "beacon/rev") "")
      ::  Respond FIRST, then record the visit. A history write is a poke to the
      ::  serialised writer. Doing it before the response would put a write on
      ::  the critical path of every page READ, which is exactly what the perf
      ::  pass took out. Safe to continue after send: a completed %simple
      ::  response drops the connection's conns entry, so no later cancel can
      ::  cull this fiber.
      ::  A peer's page gets a comment box. Their ship decides whether it
      ::  lands, by their per-page flag and their banlist, and stamps us as the
      ::  author from the transport. Our own pages keep the owner box in the /x
      ::  view instead, so this does not double up there.
      =/  cbox=tape
        ?:  =(ship.u.ref our)  ""
        (remote-comment-box ship.u.ref rel.u.ref)
      ::  the tab/history title: a real `#` heading, else the raw address.
      ::  Computed once here, shared with the history-log write below.
      =/  ttl=@t  (page-title-of u.body u.raw)
      ;<  ~  bind:m
        ;<  rv=tape  bind:m  ?:(=("" rk) (pure:(fiber:fiber:nexus ,tape) "") beacon-rev-tape)
        ?:  =("" rk)
          (send-view eyre-id (render-page-titled canon rk "" (trip ttl) (weld (render-gmi u.body) cbox)))
        (send-view-long eyre-id (render-page-titled canon rk rv (trip ttl) (weld (render-gmi u.body) cbox)))
      ::  the background self-refetch and SSE-forced refreshes re-run this
      ::  handler; they are machinery, not reading, and they mark themselves
      ::  (x-lattice-bg). Counting them double-counted every cold view and
      ::  let an open reader tab turn every autosave anywhere into a phantom
      ::  visit that pinned the entry's ttl.
      ?:  ?=(^ (get-header:http 'x-lattice-bg' header-list.request.req))
        (pure:m ~)
      (poke-history [%visit u.raw ttl])
    ==
  ::  dispatch on [method action]. ponytail: read-know-map peeks the whole vault
  ::  per request, fine for a personal store. Writes poke the single writer
  ::  fiber (serialised) and respond ok. The writer logs no-op cases (missing key
  ::  etc.) rather than 404. Precise per-route error codes can follow if a client
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
    ::  peek just the one entry grub. Hydrating the whole vault to serve a
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
  ::  dense. Version history for free, no extra storage machinery.
      [%'GET' %page-history]
    =/  name=(unit @t)  (~(get by args) 'name')
    ?~  name  (send-err eyre-id 400 'missing name')
    ?.  (valid-name u.name)  (send-err eyre-id 400 'bad name')
    =/  pdir=path  (weld /page (pax-of u.name))
    ;<  pe=(each (list [c=cass:clay s=sage:tarball]) tang)  bind:m
      (peep:io (rf up pdir %code) [%numb ~ ~])
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
  ::  page-source-at: a page's source AS OF a revision. Read-only view.
  ::  Restoring = the client re-saves the old body as a fresh revision, so
  ::  nothing is ever destroyed. The rev is validated against real history
  ::  first because peek-at bails outright on a miss.
      ::  NB: numeric URL params parse with +dim:ag, NOT +slaw %ud. slaw wants
      ::  hoon's dotted numeral syntax (1.000), so every rev >= 1000 silently
      ::  failed to parse and 400'd. With autosave, revision numbers pass 1000
      ::  within a few sessions.
      [%'GET' %page-source-at]
    =/  name=(unit @t)  (~(get by args) 'name')
    ?~  name  (send-err eyre-id 400 'missing name')
    ?.  (valid-name u.name)  (send-err eyre-id 400 'bad name')
    =/  rv=(unit @ud)  (rush (~(gut by args) 'rev' '') dim:ag)
    ?~  rv  (send-err eyre-id 400 'bad rev')
    =/  pdir=path  (weld /page (pax-of u.name))
    ;<  pe=(each (list [c=cass:clay s=sage:tarball]) tang)  bind:m
      (peep:io (rf up pdir %code) [%numb ~ ~])
    ?:  ?=(%| -.pe)  (send-err eyre-id 404 'no history')
    ?.  (lien p.pe |=([c=cass:clay *] =(ud.c u.rv)))
      (send-err eyre-id 404 'no such revision')
    ;<  sn=view:nexus  bind:m  (peek-at:io (rf up pdir %code) ~ [%ud u.rv])
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
  ::  (the ball already carries every code grub), then a local scan per page.
  ::  No external index, so it needs nothing but the page tree. No per-page
  ::  darts, so it stays flat as pages accumulate.
      [%'GET' %page-backlinks]
    =/  name=(unit @t)  (~(get by args) 'name')
    ?~  name  (send-err eyre-id 400 'missing name')
    ?.  (valid-name u.name)  (send-err eyre-id 400 'bad name')
    =/  needle=tape  :(weld "[[" (trip u.name) "]]")
    ;<  sn=view:nexus  bind:m  (peek:io (rv up /page) ~)
    ?.  ?=([%ball *] sn)
      (send-json eyre-id (pairs:enjs:format ~[['links' a+~]]))
    =/  pages=(list [pax=path when=@da code=@t])  (recent-walk ball.sn wave.sn ~)
    ::  sorted by path like the old walk. murn preserves input order
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
  ::  page-dump: page-tree PLUS every page's body inline, in ONE deep peek. Warms
  ::  a filesystem client's whole read-cache so rg/grep run from RAM. Heavier than
  ::  page-tree. Shape-only clients keep using page-tree.
      [%'GET' %page-dump]
    ;<  j=json  bind:m  fs-dump-json
    (send-json eyre-id j)
  ::
      [%'GET' %fetch]
    ::  read a published page. url=urb://~ship/rel. Own pages peek the local pub
    ::  vault. Remote pages use grubbery peek-remote (clean break: the peer must
    ::  run the grubbery-native lattice. Old %grow spurs are not read). case=~
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
    ::  never badges as a publisher. A page the user really published at
    ::  /manifest was already served above.
    ?.  =(/manifest path.u.pu)  (send-err eyre-id 404 'not found')
    ;<  mix=(unit pub-index:lp)  bind:m  (read-pub-index-any ship.u.pu)
    ?~  mix  (send-err eyre-id 404 'not found')
    (send-json eyre-id (mark-body-json 'gmi' (manifest-gmi u.mix)))
  ::  ── cross-ship browse (federated read-only tree reader) ──
  ::  list ANY grubbery ship's directory (not just lattice peers): ship=~x&path=/y.
  ::  SHALLOW (one level) so a huge/hostile remote tree can't balloon memory.
  ::  Children past browse-fan-cap are dropped with `truncated`. Owner-only (the
  ::  request handler already gates src=our), never an open proxy. A denied
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
    ::  to the input type (^+), so the possibly-empty dir would nest-fail, the same
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
  ::  remote-save: overwrite a file on ANOTHER ship. The editor's save button
  ::  pointed across ames. POST /remote-save?ship=~nec&path=/a/b/c, body = the
  ::  new text. The write is a %grubbery-load %make applied on THEIR side as a
  ::  dart from /sys/ames/ships/<us>/ship.sig, so their weir decides it.
  ::
  ::  VERIFIED BY REVISION, not trusted. The gall ack says the poke was
  ::  processed, but a weir denial after the ack is silent. We peek the file's
  ::  cass before and after. No bump, no save, and the editor says so instead
  ::  of lying "saved". (Content equality can't be the check. Their mark may
  ::  normalize the body, e.g. wain round-trips and trailing newlines.)
      [%'POST' %remote-save]
    (handle-remote-save eyre-id req args our)
  ::  ── banlist ────────────────────────────────────────────────────────────
  ::  Deny cannot be expressed as a weir (see +$banned in /lib/lattice-share),
  ::  so it is this app's own list, enforced where a foreign ship's identity is
  ::  known: the shares inbox and every grant written here.
      [%'GET' %banlist]
    ;<  bans=banned:ls  bind:m  read-banned
    %+  send-json  eyre-id
    a+(turn (sort ~(tap in bans) lth) |=(w=@p s+(scot %p w)))
  ::
  ::  ban: add, then REVOKE. A ban that left existing grants in place would be
  ::  a label, not a ban. The ship is stripped from every usergroup it is in.
      [%'POST' %ban]
    =/  st=(unit @t)  (~(get by args) 'ship')
    ?~  st  (send-err eyre-id 400 'missing ship')
    =/  who=(unit @p)  (slaw %p u.st)
    ?~  who  (send-err eyre-id 400 'bad ship')
    ?:  =(u.who our)  (send-err eyre-id 400 'that is you')
    ;<  bans=banned:ls  bind:m  read-banned
    ?:  (gth ~(wyt in bans) ban-cap:ls)
      (send-err eyre-id 400 'banlist is full')
    ;<  ~  bind:m
      (over:io (ban-road up) [[/lattice %banned] (~(put in bans) u.who)])
    ;<  n=@ud  bind:m  (strip-ship-from-groups u.who)
    %+  send-json  eyre-id
    (pairs:enjs:format ~[['ok' b+&] ['revoked' (numb:enjs:format n)]])
  ::
      [%'POST' %unban]
    =/  st=(unit @t)  (~(get by args) 'ship')
    ?~  st  (send-err eyre-id 400 'missing ship')
    =/  who=(unit @p)  (slaw %p u.st)
    ?~  who  (send-err eyre-id 400 'bad ship')
    ;<  bans=banned:ls  bind:m  read-banned
    ::  unban restores nothing. The grants were revoked, and re-granting is a
    ::  deliberate act, not a side effect of lifting a ban.
    ;<  ~  bind:m
      (over:io (ban-road up) [[/lattice %banned] (~(del in bans) u.who)])
    (send-ok eyre-id)
  ::  ── sharing groups: the permission editor (see +share-groups-json) ──
      [%'GET' %share-groups]
    ;<  j=json  bind:m  share-groups-json
    (send-json eyre-id j)
  ::  save = replace a group's ships and its UI-managed grants. Body JSON:
  ::  {ships: ["~nec"], peek: ["/apps/..."], make: ["/apps/..."]}.
  ::
  ::  PRESERVED, never replaced: the poke set (the editor has no business
  ::  granting eval power) and any road shape the editor can't render, both
  ::  carried through from the stored weir verbatim.
      [%'POST' %share-group-save]
    (handle-share-group-save eyre-id req args)
  ::  share-file: the per-file shortcut. Grant a ship read or edit on ONE
  ::  page, and tell them. The grant goes into an auto-group named after the
  ::  ship (visible and editable in the peers panel like any other group).
  ::  The notice is best-effort and the response says whether it arrived,
  ::  because the grant is durable either way.
      [%'POST' %share-file]
    =/  name=(unit @t)  (~(get by args) 'name')
    ?~  name  (send-err eyre-id 400 'missing name')
    ?.  (valid-name u.name)  (send-err eyre-id 400 'bad name')
    =/  shp-t=(unit @t)  (~(get by args) 'ship')
    ?~  shp-t  (send-err eyre-id 400 'missing ship')
    =/  shp=(unit @p)  (slaw %p u.shp-t)
    ?~  shp  (send-err eyre-id 400 'bad ship')
    ?:  =(u.shp our)  (send-err eyre-id 400 'that is you')
    ::  a banned ship must not be grantable. Otherwise the ban survives only
    ::  until the next share, and the UI would happily hand access straight back
    ;<  bans=banned:ls  bind:m  read-banned
    ?:  (is-banned:ls bans u.shp)
      (send-err eyre-id 403 'that ship is banned — unban it first')
    =/  mode=@t  (~(gut by args) 'mode' 'read')
    ?.  |(=('read' mode) =('edit' mode))  (send-err eyre-id 400 'mode: read or edit')
    =/  pdir=path  (weld /page (pax-of u.name))
    ;<  pe=?  bind:m  (peek-exists:io (rv up pdir))
    ?.  pe  (send-err eyre-id 404 'no such page')
    =/  droad=road:tarball  (rv up pdir)
    =/  gname=@t  (crip (slag 1 (scow %p u.shp)))
    ;<  ~  bind:m
      %-  ug-merge
      :^    gname
          (~(gas in *(set @p)) ~[u.shp])
        (~(gas in *(set road:tarball)) ~[droad])
      ?.  =('edit' mode)  ~
      (~(gas in *(set road:tarball)) ~[droad])
    ::  what the peer should OPEN: the page's code grub, not the dir.
    =/  npax=path  (snoc pdir %code)
    ;<  told=?  bind:m
      %^  remote-load-poke-wait  u.shp
        :-  [/share-notice %& app-base:lu %'shares.sig']
        [%poke [/lattice %share-notice] `action:ls`[%add npax mode]]
      ~s15
    %+  send-json  eyre-id
    (pairs:enjs:format ~[['ok' b+&] ['notified' b+told]])
  ::  shared-with-me: the notices other ships sent us. Claims, not
  ::  capabilities. Opening one is what proves the grant is still real.
      [%'GET' %shared-with-me]
    ;<  sn=view:nexus  bind:m  (peek:io (rf up / %shared) ~)
    =/  sh=shared:ls
      ?.  ?=([%file *] sn)  ~
      (fall (mole |.(;;(shared:ls (sang-noun:tarball sang.sn)))) ~)
    %+  send-json  eyre-id
    :-  %a
    %+  turn  sh
    |=  e=entry:ls
    %-  pairs:enjs:format
    :~  ['host' s+(scot %p host.e)]
        ['path' s+(spat pax.e)]
        ['mode' s+mode.e]
        ['when' s+(scot %da when.e)]
    ==
      [%'POST' %shared-with-me-del]
    =/  hp-t=(unit @t)  (~(get by args) 'host')
    ?~  hp-t  (send-err eyre-id 400 'missing host')
    =/  hp=(unit @p)  (slaw %p u.hp-t)
    ?~  hp  (send-err eyre-id 400 'bad host')
    =/  pt=(unit @t)  (~(get by args) 'path')
    ?~  pt  (send-err eyre-id 400 'missing path')
    =/  pp=(each path tang)  (mule |.((stab u.pt)))
    ?:  ?=(%| -.pp)  (send-err eyre-id 400 'bad path')
    ;<  ~  bind:m
      %+  poke:io  (rf up / %'shares.sig')
      [[/lattice %share-notice] `action:ls`[%del u.hp p.pp]]
    (send-ok eyre-id)
      [%'POST' %share-group-del]
    =/  gname=(unit @t)  (~(get by args) 'name')
    ?~  gname  (send-err eyre-id 400 'missing name')
    ?.  ((sane %tas) u.gname)  (send-err eyre-id 400 'bad name')
    =/  gdir=path  (snoc ug-base (crip (weld (trip u.gname) ".grp")))
    ;<  *  bind:m  (cull-soft:io [%& %| gdir])
    (send-ok eyre-id)
  ::  ── follows (the ship-level follow list) ──
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
  ::  'event: <old|add|upd|del> <name>' + 'data: <json>'. Skip the initial `old`
  ::  snapshot, then on add/upd upsert <name> with its data, on del drop it. know
  ::  and pub are DIRECTORY subscriptions (one frame per changed entry/page).
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
    ;<  pv=view:nexus  bind:m  (peek:io (rf up / %'prism.js') ~)
    ?.  ?=([%file *] pv)  (send-err eyre-id 404 'not found')
    =/  res=(each mime tang)  (mule |.(!<(mime (need-vase:tarball sang.pv))))
    ?:  ?=(%| -.res)  (send-err eyre-id 500 'bad asset')
    %+  send-simple:srv  eyre-id
    :-  [200 ~[['content-type' 'text/javascript'] ['cache-control' 'private, max-age=3600']]]
    `q.p.res
      [%'GET' %'manifest.webmanifest']
    (send-typed eyre-id 'application/manifest+json' 'public, max-age=86400' manifest-json)
      [%'GET' %'sw.js']
    (send-sw eyre-id sw-js)
      [%'GET' %'icon.svg']
    (send-typed eyre-id 'image/svg+xml' 'public, max-age=86400' icon-svg)
      [%'GET' %'apple-touch-icon.png']
    (send-png eyre-id apple-icon-b64)
      [%'GET' %edit]
    ::  the editor moved to the lattice-hosted app (ui-app/). Preserve deep
    ::  links: ?name= opens the page, ?into= starts a new file in a folder.
    ::  kind/newfolder are app-internal now.
    =/  name=(unit @t)  (~(get by args) 'name')
    =/  into=(unit @t)  (~(get by args) 'into')
    =/  target=tape
      ?^  name  (weld "/apps/lattice/app?name=" (trip u.name))
      ?^  into  (weld "/apps/lattice/app?into=" (trip u.into))
      "/apps/lattice/app"
    (send-redirect eyre-id target)
  ::  page-save-batch: N files in ONE request and ONE writer transaction.
  ::  Body is a JSON array of {name, type, body}. An upload used to be one
  ::  request per file, and each pays the pier's ~0.5s floor serially, so a
  ::  20-file folder drop was ~20 round-trips of overhead to do work that is
  ::  identical here. Every name is validated BEFORE anything is written. A
  ::  batch that half-applies and then rejects file 14 is worse than one that
  ::  refuses up front, because the client cannot tell what landed.
      [%'POST' %page-save-batch]
    (handle-page-save-batch eyre-id req args)
  ::
      [%'POST' %page-save]
    (handle-page-save eyre-id req args)
      [%'POST' %folder-new]
    ::  create an empty folder (nested ok, e.g. "a/b"). The tree shows it and
    ::  ?into= drops new files inside. Idempotent over an existing page/folder.
    =/  name=(unit @t)  (~(get by args) 'name')
    ?~  name  (send-err eyre-id 400 'missing name')
    ?.  (valid-name u.name)  (send-err eyre-id 400 'bad name')
    ;<  ~  bind:m  (poke-eval [%mkdir (pax-of u.name)])
    ;<  ~  bind:m  (poke-dnames args (pax-of u.name))
    (send-ok eyre-id)
      [%'POST' %page-preview]
    ::  live markdown preview: render the POSTed body with the real render-md
    ::  (the source-of-truth renderer, so no client/server drift) and return a
    ::  bare HTML doc. Non-persisting. Nothing is written, so the editor can
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
    ;<  ex=?  bind:m  (peek-exists:io (rf up (weld /page (pax-of u.name)) %code))
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
    ::  lands on the live view. The JSON ok stays for programmatic callers.
    ?.  (~(has by args) 'web')  (send-ok eyre-id)
    %+  send-see-other  eyre-id
    :(weld "/apps/lattice/x/" (scow %p our) "/apps/lattice.lattice_app/page/" (trip u.name) "/")
      [%'POST' %page-del]
    =/  name=(unit @t)  (~(get by args) 'name')
    ?~  name  (send-err eyre-id 400 'missing name')
    ::  raw-name-pax, not valid-name: deletion stays able to remove a page whose
    ::  name predates the dot-segment rule. Creation is where the rule belongs.
    =/  dpax=(unit path)  (raw-name-pax u.name)
    ?~  dpax  (send-err eyre-id 400 'bad name')
    ;<  ~  bind:m  (poke-eval [%del u.dpax])
    (send-ok eyre-id)
  ::  page-move: server-side move/rename of a page or a whole folder subtree.
  ::  Replaces the old client choreography (page-source + page-save + page-del
  ::  per page, folder-new per folder, 3N+M round-trips at ~2s each) with one
  ::  request. Share modes carry over. Wikilink self-references are rewritten
  ::  the same way template instantiation rewrites its root.
      [%'POST' %page-move]
    =/  from=(unit @t)  (~(get by args) 'from')
    =/  to=(unit @t)    (~(get by args) 'to')
    ?~  from  (send-err eyre-id 400 'missing from')
    ?~  to    (send-err eyre-id 400 'missing to')
    ?.  &((valid-name u.from) (valid-name u.to))  (send-err eyre-id 400 'bad name')
    ?:  =(u.from u.to)
      ::  same path: nothing to move, but a rename that changed only the
      ::  display name (My Page over my-page) lands here and still applies
      ?.  |((~(has by args) 'dname') (~(has by args) 'dnames'))
        (send-err eyre-id 400 'same name')
      ;<  ~  bind:m  (poke-dnames args (pax-of u.to))
      (send-json eyre-id (pairs:enjs:format ~[['moved' (numb:enjs:format 0)]]))
    =/  pf=path  (pax-of u.from)
    =/  pt=path  (pax-of u.to)
    ?:  &((gth (lent pt) (lent pf)) =(pf `path`(scag (lent pf) `path`pt)))
      (send-err eyre-id 400 'cannot move under itself')
    ::  never clobber: a collision replaced the destination silently (and
    ::  prune-hist's coalesce window could make it unrecoverable). /know-move
    ::  has refused this from the start; pages get the same 409.
    =/  dbase=path  (weld /page pt)
    ;<  dpg=?  bind:m  (peek-exists:io (rf up dbase %code))
    ?:  dpg  (send-err eyre-id 409 'destination exists')
    ;<  ddr=?  bind:m  (peek-exists:io (rv up dbase))
    ?:  ddr  (send-err eyre-id 409 'destination exists')
    ;<  n=(unit @ud)  bind:m  (move-pages pf pt)
    ?~  n  (send-err eyre-id 404 'no such page or folder')
    ::  ?dname= / ?dnames=: the display names for the NEW path ('' on dname
    ::  clears the one the move carried over, because the typed name was
    ::  valid as it stands; dnames names the folders the move made)
    ;<  ~  bind:m  (poke-dnames args pt)
    (send-json eyre-id (pairs:enjs:format ~[['moved' (numb:enjs:format u.n)]]))
      ::  the commons query bridge (docs/obelisk-mirror.md section 6): raw
      ::  urQL in the body, the desk's result as JSON out. Owner-gated by
      ::  the dispatch gate above like every other route. The round-trip
      ::  runs in this request's own fiber, nonce-verified against
      ::  concurrent callers, bounded by the one-minute poll deadline inside
      ::  +obelisk-run-one.
      [%'POST' %obelisk-query]
    =/  bod=@t  (req-body req)
    ?:  =('' bod)  (send-err eyre-id 400 'missing urQL body')
    =/  db=@tas
      =/  d=(unit @t)  (~(get by args) 'db')
      ?~  d  mirror-db:lm
      (fall (mole |.(;;(@tas u.d))) mirror-db:lm)
    ;<  res=obk-out:lm  bind:m
      (obelisk-run-one db (trip bod))
    (send-json eyre-id (obelisk-json res))
      [%'POST' %page-share]
    =/  name=(unit @t)  (~(get by args) 'name')
    ?~  name  (send-err eyre-id 400 'missing name')
    ?.  (valid-name u.name)  (send-err eyre-id 400 'bad name')
    =/  mode=(unit share-mode:le)  (mode-arg args)
    ?~  mode  (send-err eyre-id 400 'mode: shared, urbit, or clearweb')
    ;<  ex=?  bind:m  (peek-exists:io (rf up (weld /page (pax-of u.name)) %code))
    ?.  ex  (send-err eyre-id 404 'no such page')
    ;<  ~  bind:m  (poke-eval [%share (pax-of u.name) u.mode])
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
    ::  cap=0 (default) means no absolute limit. gap is in SECONDS, 0 = none.
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
  ::  comments-inbox: what other ships have said, across every page. Comments
  ::  arrive from anyone the page is open to and the workspace had no view of
  ::  them at all. You had to visit each published page in the reader to find
  ::  out anyone had replied.
      [%'GET' %comments-inbox]
    ;<  j=json  bind:m  comments-inbox-json
    (send-json eyre-id j)
  ::
  ::  comments-latest: the /beacon/comments stamp, one grub read. The badge
  ::  polls THIS and only pays for the full inbox when the stamp changed —
  ::  the inbox materializes every comment body (~6s of serial pier time),
  ::  which is a absurd price for "nothing new". `latest` is null until the
  ::  first comment ever arrives (or on a store from before the stamp);
  ::  the client treats null as unknown and falls back to the full fetch,
  ::  so an old store self-heals on its next comment.
      [%'GET' %comments-latest]
    ;<  v=view:nexus  bind:m
      (peek:io (rf up /beacon %comments) ~)
    =/  latest=json
      ?.  ?=([%file *] v)  ~
      (fall (mole |.(;;(json (sang-noun:tarball sang.v)))) ~)
    (send-json eyre-id (pairs:enjs:format ~[['latest' latest]]))
  ::
  ::  moderation: remove one comment. Owner-only like every non-clearweb route.
  ::  Deleting the grub is the whole operation. The reader renders from the
  ::  same tree, so it disappears there too.
      [%'POST' %comment-del]
    =/  pg=(unit @t)  (~(get by args) 'page')
    ?~  pg  (send-err eyre-id 400 'missing page')
    ?.  (valid-name u.pg)  (send-err eyre-id 400 'bad page')
    =/  id=(unit @t)  (~(get by args) 'id')
    ?~  id  (send-err eyre-id 400 'missing id')
    ?.  ((sane %ta) u.id)  (send-err eyre-id 400 'bad id')
    =/  croad=road:tarball
      (rf up (weld /comments (pax-of u.pg)) `@ta`u.id)
    ;<  *  bind:m  (cull-soft:io croad)
    (send-ok eyre-id)
  ::
      [%'POST' %page-comments]
    =/  name=(unit @t)  (~(get by args) 'name')
    ?~  name  (send-err eyre-id 400 'missing name')
    ?.  (valid-name u.name)  (send-err eyre-id 400 'bad name')
    ;<  ex=?  bind:m  (peek-exists:io (rv up (weld /page (pax-of u.name))))
    ?.  ex  (send-err eyre-id 404 'no such page or folder')
    ;<  ~  bind:m  (poke-eval [%comments (pax-of u.name) =('1' (~(gut by args) 'on' '0'))])
    (send-ok eyre-id)
      ::  owner commenting on their OWN page (author = us). Other ships comment
      ::  through the public inbox fiber. body is the raw POST body.
      [%'POST' %comment]
    =/  page=(unit @t)  (~(get by args) 'page')
    ?~  page  (send-err eyre-id 400 'missing page')
    ?.  (valid-name u.page)  (send-err eyre-id 400 'bad page')
    ::  the box POSTs a form (body=<urlencoded>). Parse it like page-cmd does.
    =/  fargs=(map @t @t)
      (malt args:(parse-url:http-utils (crip (weld "/?" (trip (req-body req))))))
    =/  body=@t  (~(gut by fargs) 'body' '')
    ?:  =('' body)  (send-err eyre-id 400 'missing body')
    ;<  ~  bind:m  (poke-comment [(pax-of u.page) body])
    ::  303 back to the page (target=_top on the box), so it reloads with the new
    ::  comment. The write is a separate transaction, so a stale reload just needs
    ::  a refresh (acceptable, like page-cmd).
    %+  send-see-other  eyre-id
    :(weld "/apps/lattice/x/" (scow %p our) "/apps/lattice.lattice_app/page/" (trip u.page) "/")
  ::  comment on ANOTHER ship's page. Owner-gated like everything here: this
  ::  is us, using our own session, choosing to say something on a page we are
  ::  reading. The peer decides whether it lands, by their banlist and their
  ::  per-page comment flag, and their ship stamps us as the author from the
  ::  transport, so nothing we send here can claim to be someone else.
  ::
  ::  `told` reports only that the poke was ACCEPTED for delivery. A silent
  ::  refusal on the far side is indistinguishable from success by design, so
  ::  the UI says "sent" rather than "posted".
      [%'POST' %comment-remote]
    =/  st=(unit @t)  (~(get by args) 'ship')
    ?~  st  (send-err eyre-id 400 'missing ship')
    =/  shp=(unit @p)  (slaw %p u.st)
    ?~  shp  (send-err eyre-id 400 'bad ship')
    =/  page=(unit @t)  (~(get by args) 'page')
    ?~  page  (send-err eyre-id 400 'missing page')
    ?.  (valid-name u.page)  (send-err eyre-id 400 'bad page')
    ::  the box POSTs a form, exactly like the local comment route
    =/  fargs=(map @t @t)
      (malt args:(parse-url:http-utils (crip (weld "/?" (trip (req-body req))))))
    =/  body=@t  (~(gut by fargs) 'body' '')
    ?:  =('' body)  (send-err eyre-id 400 'missing body')
    ::  cap before sending, so a peer never has to defend against our client
    =/  body=@t
      ?:((gth (met 3 body) max-body:lc) (end [3 max-body:lc] body) body)
    ;<  told=?  bind:m
      %^  remote-load-poke-wait  u.shp
        :-  [/comment-notice %& app-base:lu %'comments.sig']
        [%poke [/lattice %comment-action] `comment-action:lc`[(pax-of u.page) body]]
      ~s15
    ::  303 back to the reader view of the page just commented on, the same
    ::  shape /comment uses for its own redirect. A plain form submit here
    ::  used to land on this route's raw JSON body, replacing the whole
    ::  reader with {"ok":true,"sent":told}.
    %+  send-see-other  eyre-id
    %+  weld  "/apps/lattice?url="
    (url-enc (trip (en-urb:lu u.shp (weld pub-prefix:lu (pax-of u.page)))))
      ::  bookmark the current browser url (title defaults to the url). Newest
      ::  first, deduped by url. Shown under Browser on the home page.
      [%'POST' %bookmark]
    =/  url=(unit @t)  (~(get by args) 'url')
    ?~  url  (send-err eyre-id 400 'missing url')
    =/  title=@t  (~(gut by args) 'title' u.url)
    =/  folder=@t  (~(gut by args) 'folder' '')
    ;<  ~  bind:m  (poke-bookmark [%add u.url title folder])
    (send-ok eyre-id)
  ::  ── omnibar completions ─────────────────────────────────────────────────
  ::  Bookmarks and history matching `q`, for the address bar's dropdown.
  ::  Bookmarks rank above history (you chose to keep them), then by hits, then
  ::  recency. Matching is a case-insensitive substring over url AND title, so
  ::  typing a remembered word finds a page whose address you never learned.
      [%'GET' %omni-suggest]
    =/  q=@t  (~(gut by args) 'q' '')
    ;<  bms=bookmarks:lb  bind:m  read-bookmarks
    ;<  his=history:lh    bind:m  read-history
    =/  needle=tape  (cass (trip q))
    =/  hit=$-([@t @t] ?)
      |=  [u=@t t=@t]
      ^-  ?
      ?:  =("" needle)  &
      |(?=(^ (find needle (cass (trip u)))) ?=(^ (find needle (cass (trip t)))))
    =/  brows=(list [@t @t @t @ud])
      %+  turn  (skim bms |=(b=bookmark:lb (hit url.b title.b)))
      |=(b=bookmark:lb [url.b title.b 'bookmark' 0])
    ::  a url that is bookmarked is not also offered as history
    =/  marked=(set @t)  (~(gas in *(set @t)) (turn bms |=(b=bookmark:lb url.b)))
    =/  hrows=(list [@t @t @t @ud])
      %+  turn
        %+  skim  his
        |=(v=visit:lh &(!(~(has in marked) url.v) (hit url.v title.v)))
      |=(v=visit:lh [url.v title.v 'history' hits.v])
    =/  rows=(list [@t @t @t @ud])  (scag 12 (weld brows hrows))
    %+  send-json  eyre-id
    %-  pairs:enjs:format
    :~  ['ok' b+&]
        :-  'items'
        :-  %a
        %+  turn  rows
        |=  [u=@t t=@t src=@t n=@ud]
        %-  pairs:enjs:format
        :~  ['url' s+u]  ['title' s+t]  ['source' s+src]
            ['hits' (numb:enjs:format n)]
        ==
    ==
  ::  the visit list itself, newest first, for a history page or a client that
  ::  wants more than the dropdown's twelve.
      [%'GET' %history]
    ;<  his=history:lh  bind:m  read-history
    %+  send-json  eyre-id
    %-  pairs:enjs:format
    :~  ['ok' b+&]
        :-  'items'
        :-  %a
        %+  turn  his
        |=  v=visit:lh
        %-  pairs:enjs:format
        :~  ['url' s+url.v]  ['title' s+title.v]
            ['last' s+(scot %da last.v)]  ['hits' (numb:enjs:format hits.v)]
        ==
    ==
      [%'POST' %history-forget]
    =/  url=(unit @t)  (~(get by args) 'url')
    ?~  url  (send-err eyre-id 400 'missing url')
    ;<  ~  bind:m  (poke-history [%forget u.url])
    (send-ok eyre-id)
      [%'POST' %history-clear]
    ;<  ~  bind:m  (poke-history [%clear ~])
    (send-ok eyre-id)
      [%'POST' %unbookmark]
    =/  url=(unit @t)  (~(get by args) 'url')
    ?~  url  (send-err eyre-id 400 'missing url')
    ;<  ~  bind:m  (poke-bookmark [%del u.url])
    (send-ok eyre-id)
  ::  refile a bookmark (folder='' returns it to unfiled). In-place: recency
  ::  order is preserved, which a del+re-add would not do.
      [%'POST' %bookmark-move]
    =/  url=(unit @t)  (~(get by args) 'url')
    ?~  url  (send-err eyre-id 400 'missing url')
    =/  folder=@t  (~(gut by args) 'folder' '')
    ;<  ~  bind:m  (poke-bookmark [%move u.url folder])
    (send-ok eyre-id)
  ::  the whole list as JSON, for clients and tests. The /marks page is the
  ::  human view of the same data.
      [%'GET' %bookmarks]
    ;<  bms=bookmarks:lb  bind:m  read-bookmarks
    %+  send-json  eyre-id
    %-  pairs:enjs:format
    :~  ['ok' b+&]
        :-  'items'
        :-  %a
        %+  turn  bms
        |=  b=bookmark:lb
        %-  pairs:enjs:format
        ~[['url' s+url.b] ['title' s+title.b] ['folder' s+folder.b]]
    ==
  ::  ── /clip: archive a clearweb page AS a lattice page ───────────────────
  ::  A bookmark stores a link. This stores the page. The ship fetches the url
  ::  itself over iris, converts the html to markdown, and writes a normal
  ::  private page under clips/: editable, searchable and shareable like any
  ::  other, because it IS any other.
  ::
  ::  GET, not POST, because the whole point is that a bookmarklet reaches it
  ::  by top-level navigation. eyre's session cookie carries no SameSite
  ::  attribute, so a navigation sends it where a cross-site POST would not.
  ::  That does leave it CSRF-reachable (an <img src=…/clip?url=> on a hostile
  ::  page would archive a page of the attacker's choosing), which is noise in
  ::  the owner's own tree, not disclosure. The fetched body never travels
  ::  back to the attacker. +http-url is the real boundary. It keeps `file:`
  ::  and friends away from iris on both the initial url and the redirect.
      [%'GET' %clip]
    =/  url=(unit @t)  (~(get by args) 'url')
    ?~  url  (send-err eyre-id 400 'missing url')
    (clip-page eyre-id u.url)
  ::  ── /clip-paste + /clip-html: archive what the BROWSER can see ─────────
  ::  Some publishers refuse the ship (403 to any automated fetch), and a
  ::  paywalled or logged-in page is never fetchable server-side at all. In
  ::  both cases the browser is already holding the rendered page, legitimately,
  ::  so the html comes from there instead. No request to the site is made.
  ::
  ::  It takes two routes because of the session cookie. Eyre sets it with no
  ::  SameSite attribute, which browsers treat as Lax. A top-level GET
  ::  navigation carries it, a cross-site POST does not. So the bookmarklet
  ::  cannot POST the html from the article page. It would arrive
  ::  unauthenticated. Instead it OPENS /clip-paste (top-level GET, cookie
  ::  rides along), then postMessages the html to that tab, which is same-origin
  ::  with the api and can POST it to /clip-html normally.
      [%'GET' %clip-paste]
    =/  url=(unit @t)  (~(get by args) 'url')
    ?~  url  (send-err eyre-id 400 'missing url')
    (send-html eyre-id (clip-paste-html u.url))
  ::  the html arrives as the request body. `url` is only provenance and the
  ::  slug source. Nothing is fetched here.
      [%'POST' %clip-html]
    =/  url=(unit @t)  (~(get by args) 'url')
    ?~  url  (send-err eyre-id 400 'missing url')
    ?.  (http-url u.url)  (send-err eyre-id 400 'url must be http:// or https://')
    =/  body=@t  (req-body req)
    ?:  =('' body)  (send-err eyre-id 400 'no page content was sent')
    (archive-html eyre-id u.url body)
  ::  ── /share: the PWA's share-target ─────────────────────────────────────
  ::  Same archive as /clip, reached from the mobile share sheet instead of a
  ::  bookmarklet. Declared in the manifest as a GET target, so the OS performs
  ::  a top-level navigation and the eyre session cookie rides along exactly as
  ::  it does for the bookmarklet.
  ::
  ::  The url can arrive in ANY of three params. Android overwhelmingly shares a
  ::  page as `text` (often "Some Title https://example.com/x"), iOS and
  ::  well-behaved apps use `url`, and some senders put it in `title`. Taking
  ::  only `url` would make the share sheet appear to do nothing on the platform
  ::  most likely to use it, so all three are searched for the first http(s)
  ::  token.
      [%'GET' %share]
    =/  cand=(list @t)
      %+  murn  ~['url' 'text' 'title']
      |=(k=@t (~(get by args) k))
    =/  found=(unit @t)  (first-url cand)
    ?~  found
      %+  send-html  eyre-id
      %-  render-page
      :^    ""  ""  ""
      ;:  weld
        "<h1>Nothing to archive</h1>"
        "<p class=\"muted\">That share didn&rsquo;t contain a web address.</p>"
        "<p><a href=\"/apps/lattice\">back to lattice</a></p>"
      ==
    (clip-page eyre-id u.found)
      [%'POST' %page-share-tree]
    ::  publish/unpublish a whole subtree at once: set `mode` on every page
    ::  under a folder. name is the folder path. mode=clearweb publishes a site,
    ::  mode=private takes it all down.
    =/  name=(unit @t)  (~(get by args) 'name')
    ?~  name  (send-err eyre-id 400 'missing name')
    ?.  (valid-name u.name)  (send-err eyre-id 400 'bad name')
    =/  mode=(unit share-mode:le)  (mode-arg args)
    ?~  mode  (send-err eyre-id 400 'mode: shared, urbit, or clearweb')
    ;<  ~  bind:m  (poke-eval [%share-tree (pax-of u.name) u.mode])
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
    ;<  sn=view:nexus  bind:m  (peek:io (rv up /template) ~)
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
      (peek-exists:io (rf up (weld /page (pax-of u.nm)) %code))
    ?:  ex  (send-err eyre-id 409 'a page by that name exists')
    ;<  ~  bind:m  (instantiate-template `@tas`u.tmpl (pax-of u.nm))
    ;<  ~  bind:m  (poke-dnames args (pax-of u.nm))
    (send-ok eyre-id)
      [%'POST' %save]
    =/  rel=(unit @t)  (~(get by args) 'path')
    ?~  rel  (send-err eyre-id 400 'missing path')
    ::  reject an EMPTY path value (?path=): pub-path('') is /pub/gmi, a degenerate
    ::  key the reader maps back to /index, so it would mis-index and be unreadable.
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
    (send-ok eyre-id)
  ::  ── pub version history ──
  ::  every published page is a firm grub, so grubbery keeps every prior revision.
  ::  list a page's revisions (rev = the opaque grub revision id, with its date.
  ::  Key the UI on the date, revs are not contiguous). read-at + restore ONLY ever
  ::  pass a rev that came from this list. peek-at -> resolve-case BAILS the whole
  ::  event on a missing case, so an unvalidated number would crash the request.
      [%'GET' %pub-history]
    =/  raw=(unit @t)  (~(get by args) 'path')
    ?~  raw  (send-err eyre-id 400 'missing path')
    =/  ro=(unit road:tarball)  (pub-road up u.raw)
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
    =/  ro=(unit road:tarball)  (pub-road up u.raw)
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
  ::  lands as a fresh firm revision (index + gain stay consistent). Non-destructive.
  ::  The current body is itself retained in history.
      [%'POST' %pub-restore-rev]
    =/  raw=(unit @t)  (~(get by args) 'path')
    ?~  raw  (send-err eyre-id 400 'missing path')
    =/  rv=(unit @t)  (~(get by args) 'rev')
    ?~  rv  (send-err eyre-id 400 'missing rev')
    =/  rev=(unit @ud)  (rush u.rv dim:ag)
    ?~  rev  (send-err eyre-id 400 'bad rev')
    =/  ro=(unit road:tarball)  (pub-road up u.raw)
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
  ::  drops the picked old revisions and decrements silo refs. The live rev is never
  ::  dropped (keep>=1 keeps the newest, and the top cass is excluded from the drop
  ::  set). Request-fiber + explicit cass set: no writer serialization, no open
  ::  range. Shrinks what /pub-history lists. /pub-read-at on a dropped rev 404s.
      [%'POST' %pub-prune]
    =/  raw=(unit @t)  (~(get by args) 'path')
    ?~  raw  (send-err eyre-id 400 'missing path')
    =/  keep=(unit @ud)
      =/  kp=(unit @t)  (~(get by args) 'keep')
      ?~  kp  `10
      =/  k=(unit @ud)  (rush u.kp dim:ag)
      ?~(k ~ `(max 1 u.k))
    ?~  keep  (send-err eyre-id 400 'bad keep')
    =/  ro=(unit road:tarball)  (pub-road up u.raw)
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
  ::  key's history is under /know/vault. A deleted key's is under /know/trash-vault
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
  ::  for a trashed key too. %import revives it live. Non-destructive. The current
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
  ::  body is NEVER dropped. Two guards: keep>=1 leaves the newest in the kept
  ::  segment, and the top cass is explicitly removed from the drop set. Uses %pick
  ::  (an explicit cass set), never an open %numb/%date range, so even a concurrent
  ::  write can't widen the drop into the live rev. Runs in the request fiber (prune
  ::  touches only old revs, not the know-index, so no writer serialization needed).
  ::  A lose failure 500s this one request. It can't park the writer. Trashed keys
  ::  are out of scope. This targets the live vault only.
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
    =/  road=road:tarball  (entry-road up /know/vault u.ko)
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
  ::  page live, so the reader learns of an edit the moment the peer makes it.
  ::  /unsub tears the keep down.
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
      [%'GET' %settings]
    (send-view eyre-id (render-page-titled "" "" "" "settings" settings-html))
      ::  commons mirror status for the settings page: is the %obelisk
      ::  desk's agent running, and is the mirror enabled.
      [%'GET' %obelisk-status]
    ::  a %gu scry is blocked in fiber context, so presence is the sub's
    ::  live grub (instant when the mirror has ever watched) with a real
    ::  SELECT round trip as the fallback verdict (slow only when the
    ::  desk is absent, which is exactly when the page says installing).
    ;<  installed=?  bind:m  obelisk-installed
    ;<  on=?  bind:m  mirror-enabled
    %+  send-json  eyre-id
    (pairs:enjs:format ~[['installed' b+installed] ['enabled' b+on]])
      ::  fire the kiln install toward the distributor. Fire-and-forget
      ::  by the same rule as every gall poke here (the ack never routes
      ::  back to a fiber); the settings page polls /obelisk-status.
      [%'POST' %obelisk-install]
    ;<  ~  bind:m
      (gall-poke-fire %hood [%kiln-install [%obelisk ~dister-nomryg-nilref %obelisk]])
    (send-ok eyre-id)
      [%'POST' %mirror-config]
    =/  en=(unit @t)  (~(get by args) 'enabled')
    ?~  en  (send-err eyre-id 400 'enabled=true|false required')
    ?.  |(=('true' u.en) =('false' u.en))
      (send-err eyre-id 400 'enabled=true|false required')
    ;<  ~  bind:m
      %^  put-file  (rf up /mirror %'config.json')
        [/ %json]
      (pairs:enjs:format ~[['enabled' b+=('true' u.en)]])
    (send-ok eyre-id)
      [%'GET' %marks]
    ;<  bms=bookmarks:lb  bind:m  read-bookmarks
    (send-view eyre-id (render-page-titled "" "" "" "marks" (marks-html bms)))
  ::  ── editing arbitrary grubs (write apps in the editor) ──────────────────
  ::  grub-source: any grub's editable text. `editable` is false for a binary
  ::  or opaque grub. The client shows it read-only rather than offering a save
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
    ::  a full peek, not peek-exists. An overwrite needs the grub's CURRENT blot
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
      ::  the mark rejected the source. Report it so the editor can show it. The
      ::  grub still holds its previous content.
      ::  +tang-text renders the mark's failure as plain text for the editor.
      (send-err eyre-id 400 (tang-text p.bk))
    ;<  ~  bind:m
      ?:  ex  (over:io rod.u.ro p.bk)
      (make:io rod.u.ro |+[p.bk ~])
    (send-ok eyre-id)
  ::  grub-folder: create a directory, how a NEW app starts, since an app is
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
  ::  labelled with the visibility recorded at index time. One peek of one
  ::  bucket, whatever the corpus size.
  ::
  ::  Owner-gated like every route below the gate, which is what makes it safe
  ::  to return private rows at all. The results page is served from the root
  ::  route, also behind the gate. The only unauthenticated surfaces (clearweb
  ::  /c/, public form POST /f/, PWA assets) dispatch above it.
      [%'GET' %content-search]
    =/  term=(unit @t)  (~(get by args) 'term')
    ?~  term  (send-err eyre-id 400 'missing term param')
    =/  nt=(unit @t)  (normalize-term:li (trip u.term))
    ::  a non-indexable term (too short / stop word) matches nothing. 200 with
    ::  no rows, NOT a 400, so a client fanning out one call per query word
    ::  doesn't error on a common stop word.
    ?~  nt
      %+  send-json  eyre-id
      %-  pairs:enjs:format
      :~  ['ok' b+&]
          ['columns' a+(turn ~['scope' 'key' 'tf'] |=(c=@t s+c))]
          ['rows' a+~]
      ==
    ::  ONE peek of ONE bucket, whatever the corpus size. The bucket is named by
    ::  hashing the term, so this never reads the /idx directory. A directory
    ::  peek would materialise the whole index (docs/native-index.md).
    ;<  hits=(list [scope=@t key=@t tf=@ud])  bind:m  (index-look u.nt)
    %+  send-json  eyre-id
    %-  pairs:enjs:format
    :~  ['ok' b+&]
        ['columns' a+(turn ~['scope' 'key' 'tf'] |=(c=@t s+c))]
        ['count' (numb:enjs:format (lent hits))]
      :-  'rows'
      :-  %a
      %+  turn  hits
      |=  [scope=@t key=@t tf=@ud]
      a+~[s+scope s+key s+(scot %ud tf)]
    ==
  ::  page-scopes: every page's path and exposure, in ONE peek.
  ::
  ::  The editor's search greps the page-dump the client already holds. That is
  ::  live (a page written a second ago is in it) and it matches partial words,
  ::  neither of which the term index does. But the dump carries no share mode,
  ::  and a result list that cannot say which hits are published would show
  ::  private notes and clearweb pages looking identical. That is the one
  ::  failure worth a route: the badge is a safety signal, not decoration.
  ::
  ::  Same walk +content-reindex does, without the term extraction.
      [%'GET' %page-scopes]
    ;<  sn=view:nexus  bind:m  (peek:io (rv up /page) ~)
    =/  pages=(list [rel=path body=@t shr=share-mode:le])
      ?.  ?=([%ball *] sn)  ~
      (index-walk ball.sn ~)
    =/  items=(list json)
      %+  turn  pages
      |=  [rel=path body=@t shr=share-mode:le]
      ^-  json
      %-  pairs:enjs:format
      :~  ['path' s+(crip (pax-str rel))]
          ['scope' s+(scope-of shr)]
      ==
    (send-json eyre-id (pairs:enjs:format ~[['items' a+items]]))
  ::  search-reindex: rebuild the term index from the live tree + know vault.
  ::  Blocking, though the client treats it as fire-and-forget.
      [%'POST' %search-reindex]
    ;<  ~  bind:m  content-reindex
    (send-ok eyre-id)
  ::  pub-regrow: backfill the remote-scry namespace from the pub vault (see
  ::  +pub-regrow). One-shot after deploying the mesa mirror onto a ship that
  ::  already published. Harmless to re-run (each re-grow lands a fresh gall
  ::  case on the same rev spur, latest wins). Owner-only like every route.
      [%'POST' %pub-regrow]
    ;<  n=@ud  bind:m  pub-regrow
    %+  send-json  eyre-id
    (pairs:enjs:format ~[['ok' b+&] ['grown' (numb:enjs:format n)]])
  ::  pub-reconcile: ONE-SHOT cleanup of the historical-rev namespace leak
  ::  left by any publish that ran BEFORE +apply-pub culled predecessors.
  ::  Each such save grew a fresh rev spur without culling the old one, and
  ::  each such publish grew a fresh index seq without culling the old one,
  ::  so the ship holds stale rev spurs and stale index seqs, all
  ::  world-readable via keen forever. This retracts them from the vault
  ::  grubs' own version history. Owner-only. 409s on a second run. See
  ::  +pub-reconcile for the marker, the ordering rule and the enumeration
  ::  gap.
      [%'POST' %pub-reconcile]
    ;<  res=(unit [revs=@ud seqs=@ud])  bind:m  pub-reconcile
    ?~  res  (send-err eyre-id 409 'already reconciled')
    %+  send-json  eyre-id
    %-  pairs:enjs:format
    :~  ['ok' b+&]
        ['revs-culled' (numb:enjs:format revs.u.res)]
        ['seqs-culled' (numb:enjs:format seqs.u.res)]
    ==
  ::  ── legacy agent migration (see the +legacy-live block) ────────────────
  ::  legacy-status: should the UI offer to import from a retired %lattice
  ::  gall agent? One %gu liveness scry and nothing else. See below. The
  ::  client asks once per browser session and never again once resolved.
      [%'GET' %legacy-status]
    ;<  done=?  bind:m  legacy-resolved
    ?:  done
      (send-json eyre-id (pairs:enjs:format ~[['prompt' b+|] ['reason' s+'resolved']]))
    ::  %gu ONLY. This route runs on the editor's boot path, and a %gx against
    ::  an agent whose version lacks the arm does not fail gracefully. It
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
  ::  ALREADY exists here are SKIPPED, never overwritten. The live store is
  ::  always the newer one, and a legacy body must never revert an edit made
  ::  since. That also makes a re-run harmless.
      [%'POST' %legacy-migrate]
    (handle-legacy-migrate eyre-id)
  ::  legacy-dismiss: the user declined. Same marker as a completed import, so
  ::  the prompt never returns.
      [%'POST' %legacy-dismiss]
    ;<  ~  bind:m  (poke-eval [%legacy-seen 0])
    (send-ok eyre-id)
  ::  bulk import: body = a /know-all export. Lands each entry VERBATIM (tags +
  ::  original updated preserved) via %import. Owner-only.
      [%'POST' %know-import]
    =/  jon=(unit json)  (de:json:html (req-body req))
    ?~  jon  (send-err eyre-id 400 'bad json')
    =/  parsed=(each (list [@t know-entry:lk]) tang)  (mule |.((parse-import u.jon)))
    ?:  ?=(%| -.parsed)  (send-err eyre-id 400 'bad import shape')
    ::  reject the whole batch if any key is unparseable as a path. The writer
    ::  would otherwise skip those entries (silent partial import).
    ?:  (lien p.parsed |=([k=@t *] ?=(~ (know-key k))))
      (send-err eyre-id 400 'invalid key in import')
    ;<  n=@ud  bind:m  (import-know-loop p.parsed 0)
    (send-json eyre-id (pairs:enjs:format ~[['imported' (numb:enjs:format n)]]))
  ::  ── know writes (POST) ──
  ::  keys are normalised via know-key (prepends a leading /) before poking. The
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
    ::  but the route surfaces the right code, and closes the read/poke TOCTOU
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
::  in-app import rather than migrating silently. The entries are the user's,
::  and which store they want them in is their call.
::
::  DETECTION IS %gu, NEVER a bare %gx. A %gx against an absent agent BAILS,
::  and a bail here crashes the whole Arvo event. %gu answers %.n
::  instead. So: liveness first, peek second.
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
::  +legacy-mark-road: the "done with the old agent" marker. Its EXISTENCE is
::  the whole signal (the body is detail for humans), so the read is a
::  peek-exists and can never mis-parse. Written on a completed import AND on
::  an explicit dismissal, so neither path ever prompts again.
::  takes the depth rather than reading one: it is not a fiber, so it cannot
::  ask +nexus-up itself, and its one caller is.
++  legacy-mark-road  |=(up=@ud ^-(road:tarball (rf up /legacy %state)))
++  legacy-resolved
  =/  m  (fiber:fiber:nexus ,?)
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  (peek-exists:io (legacy-mark-road up))
::  +legacy-pages: how many PAGES the retired agent still holds. This import
::  moves knowledge only. The old agent exposes no arm for page BODIES
::  (%published and %live-list give paths and hashes, nothing more), so pages
::  stay behind. We count them because a user who retires the agent while pages
::  remain loses them permanently, and the completion dialog has to say so.
::  Called ONLY from /legacy-migrate, never on the boot path. Like every %gx it
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
::  this nexus's writer, a native pub-action, so bodies land in /pub/vault.
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
  ::  re-widen after the ?~. scag/rear are wet gates and mull-grow against the
  ::  narrowed (non-null) type, which is a nest-fail at the call site.
  =/  r=path  `path`t.u.pu
  ?.  =(%gmi (rear r))  ~
  ?:  =(1 (lent r))  ~
  `(scag (dec (lent r)) r)
::  +legacy-page-rels: the pages the retired agent holds, as nexus rels. A
::  shape mismatch yields ~, which callers MUST treat as "unknown", never as
::  "none". Reporting zero pages is what would wrongly clear the agent for
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
  ;<  up=@ud  bind:m  nexus-up
  ;<  sn=view:nexus  bind:m
    (peek:io (rf up /legacy %pages) ~)
  ?.  ?=([%file *] sn)  (pure:m ~)
  =/  j=(unit json)  (mole |.(;;(json (sang-noun:tarball sang.sn))))
  ?~  j  (pure:m ~)
  =/  r=(each (list @t) tang)  (mule |.(((ar:dejs:format so:dejs:format) u.j)))
  ?:  ?=(%| -.r)  (pure:m ~)
  (pure:m (murn p.r |=(c=@t (mole |.(`path`(stab c))))))
::  +legacy-page-bodies: the retired agent's page bodies, by SCRY.
::
::  The deployed agents carry a `[%x %content ~]` peek that dumps the content
::  map as {spat-key: gemtext}, the temporary migration arm from the original
::  cutover. That is the same %gx mechanism the knowledge import uses, and it
::  needs nothing from the agent beyond a read.
::
::  This replaces an earlier design that poked the agent's own /pub-migrate
::  endpoint. That endpoint does not exist in the deployed version (state-10
::  has no pub-migrate at all), so the poke was delivered, matched no route,
::  404'd, emitted nothing, and acked positively, a silent no-op that cost a
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
::  to `tries`. Replaces a fixed sleep. The arrivals are one writer
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
  ;<  up=@ud  bind:m  nexus-up
  ?~  rels  (pure:m ~)
  ;<  ex=?  bind:m
    (peek-exists:io (rf up (weld /pub/vault i.rels) %gmi))
  ;<  rest=(list path)  bind:m  $(rels t.rels)
  (pure:m ?:(ex [i.rels rest] rest))
::  +page-sources-present: which of `rels` already exist as editable pages.
::  Used to refuse a legacy page whose name collides with one of ours, since
::  the writer's %save-page is an unconditional upsert.
++  page-sources-present
  |=  rels=(list path)
  =/  m  (fiber:fiber:nexus ,(list path))
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  ?~  rels  (pure:m ~)
  ;<  ex=?  bind:m
    (peek-exists:io (rf up (weld /page i.rels) %code))
  ;<  rest=(list path)  bind:m  $(rels t.rels)
  (pure:m ?:(ex [i.rels rest] rest))
::  +write-legacy-pages: create an editable page per legacy body. Skips any
::  rel that already has a source. The collision guard runs before this, but
::  the check is cheap and this must never overwrite a page of the user's.
++  write-legacy-pages
  |=  [items=(list [rel=path body=@t]) made=@ud]
  =/  m  (fiber:fiber:nexus ,@ud)
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  ?~  items  (pure:m made)
  =/  pdir=path  (weld /page rel.i.items)
  ;<  ex=?  bind:m  (peek-exists:io (rf up pdir %code))
  ?:  ex  $(items t.items)
  ::  the editable source…
  ;<  ~  bind:m  (poke-eval [%make rel.i.items (wrap-content %gmi body.i.items)])
  ::  …AND publish it. These pages were PUBLISHED in the old agent. That is
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
  ;<  up=@ud  bind:m  nexus-up
  =|  made=@ud
  |-  ^-  form:m
  ?~  rels  (pure:m made)
  =/  pdir=path  (weld /page i.rels)
  ;<  ex=?  bind:m  (peek-exists:io (rf up pdir %code))
  ?:  ex  $(rels t.rels)
  ;<  vn=view:nexus  bind:m
    (peek:io (rf up (weld /pub/vault i.rels) %gmi) ~)
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
::  convert to the target blot. With no warm tube it silently REPLACES the
::  grub's blot with /mime. Verified on a scratch grub: writing hoon source
::  over a /hoon grub left `[mark: /mime]`, after which every later save was
::  refused ("blot differs"), so a single typo permanently changed the file's
::  type and locked out the fix. So the conversion is done HERE, explicitly:
::  fetch the extension's tube, apply it inside +mule, and only write once it
::  has produced a value. A tube failure (unparseable hoon) becomes a 400 with
::  the error and leaves the grub untouched, which also avoids `over`'s other
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
  ::  accept both `/apps/x/y` and `apps/x/y`. +stab needs the leading slash,
  ::  and a hand-typed or link-built path is easy to get wrong either way.
  ::  NOT (cat 3 '/' raw): +end takes an explicit bite here, as it does
  ::  everywhere else in this file.
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
::  (hoon, md, css, js. The %hoon mark stores SOURCE, not an AST) reads
::  directly; a mime grub goes through +mime-text, which refuses binary.
++  grub-text
  |=  =sang:tarball
  ^-  (unit @t)
  =/  nn=*  (sang-noun:tarball sang)
  =/  c=(each @t tang)  (mule |.(;;(@t nn)))
  ?:  ?=(%& -.c)  `p.c
  ::  a /txt grub is a wain, not a cord. Without this branch every remote
  ::  ship's .txt file rendered as "binary grub" and got no edit affordance.
  ::  Checked BEFORE mime. A wain coincidentally nests in nothing else here.
  =/  wn=(each wain tang)  (mule |.(;;(wain nn)))
  ?:  ?=(%& -.wn)  `(of-wain:format p.wn)
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
::  +fetch-hops: redirect hops to follow. One was not enough. An ordinary site
::  chains http->https->www->canonical, and stopping at the first hop reported
::  "could not fetch" for pages that were perfectly reachable.
++  fetch-hops  ^-(@ud 5)
::  +weir-json: every road lattice reaches outside its own tree, with the
::  reason a person would need to judge it.
::
::    The `why` strings are the text the shell shows when it asks, so each
::    says what the road buys the user rather than what the code does.
::
::    Four of these six are ambient - deny any and lattice does not run at
::    all, so "no" is not a considered answer. Two are real decisions, and
::    both are real only because the road is coarser than the need:
::
::      /sys/iris  is "fetch any URL on the internet". Lattice wants it to
::      read a web page and keep it as a note. A user who only writes local
::      notes could rationally refuse, and should be able to.
::
::      /sys/gall  is "poke any agent with any mark", which includes %hood
::      with %kiln-install - so this one road is also "install software on
::      this ship". Lattice uses it for exactly one thing a user asked for
::      (installing obelisk from the settings page) and for talking to
::      grubbery on other ships. Nothing narrower can be asked for today.
::
::    See docs/distribution-proposal.md in the auspex repo, section 4.5.
::
++  weir-json
  ^-  json
  =/  line
    |=  [r=@t w=@t]
    `json`(pairs:enjs:format ~[['road' s+r] ['why' s+w]])
  %-  pairs:enjs:format
  :~  :-  'poke'
      :-  %a
      :~  %+  line  '/sys/bowl.sig'
          'read the clock and the name of this ship: every page records when it changed and who wrote it'
          %+  line  '/sys/behn/'
          'run scheduled work - backups, the mirror pass - and give up on a fetch that is not coming'
          %+  line  '/sys/eyre/'
          'serve the reader, the editor and your published pages at /apps/lattice'
          %+  line  '/sys/scry/'
          'publish your public pages so other ships can read them, read theirs, and check whether obelisk is installed'
          %+  line  '/sys/iris/'
          'fetch a web page you ask for and keep it as a note. This road is any URL, not only the ones you name'
          %+  line  '/sys/gall/'
          'talk to other agents on this ship and to grubbery on other ships. This one road also reaches %hood, so it can install software here - lattice uses that only for the obelisk install button'
      ==
    ::  the usergroup road is a READ, and it is OPTIONAL: refuse it and
    ::  every local feature still works. +exists-soft is what makes that
    ::  true rather than aspirational - it treats a veto as "no such group"
    ::  and the arm takes its existing local-only branch.
    ::
      :-  'peek'
      :-  %a
      :~  %+  line  '/sys/ames/usergroups/'
          'let other ships read the pages you publish. Refuse this and lattice still works completely for you - your published pages just stay on this ship'
      ==
  ==
::
::  +fetch-url: GET a clearweb url through iris, following redirects.
::
::  Returns the body, or a REASON. Never bails. A request fiber that crashes
::  leaves the browser hanging on a dead connection, so every failure comes back
::  as a value. And the reason is carried out rather than flattened to ~. A bare
::  "could not fetch that page" is useless to whoever is standing there, since
::  a 403 from a bot-blocking site, a timeout and a dead host all need different
::  responses from the user.
++  fetch-url
  |=  url=@t
  =/  m  (fiber:fiber:nexus ,(each @t @t))
  ^-  form:m
  =/  hed=(list [@t @t])
    :~  ['User-Agent' 'lattice-clip']
        ::  honest content negotiation. Some sites serve a readable document
        ::  only when asked for one. NOT a browser UA. Pretending to be Chrome
        ::  to get past bot mitigation is evasion, and this fetches on the
        ::  owner's behalf under their own name.
        ['Accept' 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8']
    ==
  =|  hops=@ud
  =/  cur=@t  url
  |-  ^-  form:m
  ?:  (gth hops fetch-hops)
    (pure:m [%| 'that page redirects too many times'])
  ;<  ~  bind:m  (send-request:io [%'GET' cur hed ~])
  ;<  res=client-response:iris  bind:m  take-client-response:io
  ?.  ?=(%finished -.res)
    (pure:m [%| 'the request did not complete (host unreachable, or timed out)'])
  =/  status=@ud  status-code.response-header.res
  ?:  ?|  =(status 301)  =(status 302)  =(status 303)
          =(status 307)  =(status 308)
      ==
    =/  loc=(unit @t)
      (~(get by (malt headers.response-header.res)) 'location')
    ?~  loc  (pure:m [%| 'the site redirected without saying where'])
    ?.  (http-url u.loc)
      ::  a relative Location needs the base url resolved against it. Say so
      ::  rather than reporting a generic failure
      (pure:m [%| 'the site redirected to a relative address, which is not supported yet'])
    $(cur u.loc, hops +(hops))
  ?.  =(200 status)
    =/  s=tape  (a-co:co status)
    ?:  |(=(status 403) =(status 401) =(status 429))
      (pure:m [%| (crip (weld "the site refused the request (" (weld s ") — many publishers block automated fetches")))])
    (pure:m [%| (crip (weld "the site answered " s))])
  ?~  full-file.res  (pure:m [%| 'the site sent an empty page'])
  (pure:m [%& q.data.u.full-file.res])
::  +clip-page: fetch a url, convert it, file it under clips/, and render the
::  confirmation. Shared by /clip (bookmarklet) and /share (PWA share target).
::  The two differ only in how the url reaches us.
++  clip-page
  |=  [eyre-id=@ta url=@t]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ?.  (http-url url)  (send-err eyre-id 400 'url must be http:// or https://')
  ;<  got=(each @t @t)  bind:m  (fetch-url url)
  ?:  ?=(%| -.got)  (send-err eyre-id 502 p.got)
  (archive-html eyre-id url p.got)
::  +archive-html: convert html we already hold and file it under clips/.
::  Split out of +clip-page so the browser can supply the html directly (see
::  /clip-html). A publisher that refuses the SHIP still renders the page fine
::  in the browser that is authorised to read it, and paywalled or logged-in
::  pages are only ever available that way.
++  archive-html
  |=  [eyre-id=@ta url=@t html=@t]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  =/  got=@t  html
  =/  ttl=@t  (fall (page-title:lcl got) url)
  ;<  free=(unit path)  bind:m  (clip-free (clip-slug url))
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
      "*archived from <"  (trip url)  "> on "  day  "*"  nl  nl
      "---"  nl  nl
      (trip (to-md:lcl got))
    ==
  ::  %md, NOT %gmi. The converter emits markdown; filing it as gemtext meant
  ::  the preview ran the gemtext renderer over it, so headings, bold, italics
  ::  and links all came out as literal punctuation. (The two %gmi calls in the
  ::  legacy migration are correct. Those pages really are gemtext.)
  ;<  ~  bind:m  (poke-eval [%make u.free (wrap-content %md body)])
  ::  private by default, deliberately. Archiving someone else's page and
  ::  republishing it to the clearweb in one click is not a default anyone
  ::  should get by accident. The share control is one click away.
  =/  nom=tape  (pax-str u.free)
  %+  send-html  eyre-id
  %-  render-page
  :^    ""  ""  ""
  ;:  weld
    "<h1>Archived</h1>"
    "<p>"  (esc (trip ttl))  "</p>"
    "<p class=\"muted\">saved privately as <code>"  (esc nom)  "</code></p>"
    ::  ?name=: without it this opened the editor's default view rather than
    ::  the thing just archived. The slug is [a-z0-9-] joined by /, so it needs
    ::  no percent-encoding. esc is for the html context.
    "<p><a href=\"/apps/lattice/app?name="  (esc nom)  "\">open in the editor</a></p>"
  ==
::  +first-url: the first http(s) token across some candidate strings. A share
::  sheet rarely hands over a bare url (Android typically sends
::  "Page Title https://example.com/x" as `text`), so the url has to be picked
::  out of surrounding prose rather than assumed to be the whole field.
++  first-url
  |=  cands=(list @t)
  ^-  (unit @t)
  |-  ^-  (unit @t)
  ?~  cands  ~
  =/  hit=(unit @t)  (url-in (trip i.cands))
  ?^  hit  hit
  $(cands t.cands)
::  +url-in: scan a tape for the first http:// or https:// run, ending at
::  whitespace. ~ when there is none.
++  url-in
  |=  t=tape
  ^-  (unit @t)
  |-  ^-  (unit @t)
  ?~  t  ~
  ::  widened copy: the run-scan below walks the same text, and a second ?~ on
  ::  the face this ?~ already narrowed is a vain branch
  =/  tt=tape  `tape`t
  ?.  ?|  =("http://" (scag 7 tt))
          =("https://" (scag 8 tt))
      ==
    $(t t.t)
  =/  run=tape
    =/  s=tape  tt
    |-  ^-  tape
    ?~  s  ~
    ?:  ?|(=(' ' i.s) =(`@tD`9 i.s) =(`@tD`10 i.s) =(`@tD`13 i.s))  ~
    [i.s $(s t.s)]
  ?~(run ~ `(crip `tape`run))
::  +http-url: is this an http(s) url? The ship fetches whatever /clip is
::  handed, so this is the trust boundary. It keeps `file:`, `data:` and any
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
  ::  cap the INPUT rather than counting output. A long query string can't
  ::  produce an unusable page name, and there is no length counter to keep.
  =.  t  (scag 60 t)
  ::  one pass, accumulating REVERSED. Never weld onto a growing tape.
  ::  `dash` starts set so leading separators are dropped. A trailing hyphen
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
::  overwrites an existing archive. A re-clip of the same url lands beside the
::  old one. Gives up after -9 rather than looping forever.
++  clip-free
  |=  slug=@t
  =/  m  (fiber:fiber:nexus ,(unit path))
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  =|  n=@ud
  |-  ^-  form:m
  ?:  (gth n 9)  (pure:m ~)
  =/  nom=@t  ?:(=(0 n) slug (crip :(weld (trip slug) "-" (a-co:co +(n)))))
  =/  rel=path  ~[%clips nom]
  ;<  ex=?  bind:m  (peek-exists:io (rf up (weld /page rel) %code))
  ?.  ex  (pure:m `rel)
  $(n +(n))
::  +poke-know / +poke-pub: poke the single writer fiber (root /main.sig) with a
::  typed action. grubbery vales the noun through the action marc. The writer
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
::  dojo would print, NOT a raw [i=[%palm ...]] noun dump. The page is
::  compiled via (slap !>(pg) (ream src)), so slap stamps its own call site
::  (nex/lattice/app.hoon:<...>) into the trace. Those lines are noise to a
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
  |=  [root=@ud now=@da =sage:tarball]
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
  ?:  =([/lattice %history-action] p.sage)
    (apply-history root now !<(history-action:lh q.sage))
  ~&([%lattice-bad-mark p.sage] (pure:m ~))
::  +bump-rev: write `now` to the /rev change beacon. A distinct value each call
::  (bowl-now is monotonic) guarantees a keep-SSE news event fires, so every open
::  reader watching /rev live-reloads. Cheap. /rev is one json number, not a page.
::
++  bump-rev
  |=  now=@da
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  ::  the beacon must be NESTED (under /beacon). grubbery's keep-SSE does not
  ::  stream a grub at the nexus root (verified: /rev and /bookmarks keeps stay
  ::  silent. Nested grubs like /pub/index stream fine). Gain is not required.
  (put-file (rf up /beacon %rev) [/ %json] (numb:enjs:format `@ud`now))
::  +poke-eval: send an eval-action to the writer (serialized like all writes).
::
++  poke-eval
  |=  act=eval-action:le
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  (poke:io [%| 2 %& ~ %'main.sig'] [[/lattice %eval-action] act])
::  +poke-eval-abs: like +poke-eval, but an ABSOLUTE road to the writer.
::
::  +poke-eval's up-2 is only correct from /ui/requests. The /sub keep fibers
::  and /fs.sig sit at other depths, so no fixed hop count serves them all. An
::  absolute road is depth-independent; a relative one from the app root
::  overshoots and the poke nacks.
::
++  poke-eval-abs
  |=  act=eval-action:le
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  (poke:io (rf up / %'main.sig') [[/lattice %eval-action] act])
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
::  +poke-history: record/forget a visit via the owner writer.
++  poke-history
  |=  act=history-action:lh
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  (poke:io [%| 2 %& ~ %'main.sig'] [[/lattice %history-action] act])
::  +apply-eval: page create/command/delete, in the writer fiber.
::
++  apply-eval
  |=  [root=@ud now=@da act=eval-action:le]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  ::  name.act only resolves after ?- narrows the fork (%del is a 2-cell,
  ::  the others 3-cells. The face sits at different axes).
  ?-  -.act
      %make
    ;<  ~  bind:m  (make-page root pax.act src.act)
    ::  a shared page's vault copy follows every write, not just the share click
    (republish-if-shared root now pax.act src.act)
      %make-many
    ::  Same work as %make, once per page, but inside ONE writer transaction.
    ::  The saving is the ~0.5s pier floor an upload used to pay per FILE. The
    ::  per-page darts are unchanged, so a batch is exactly as durable as the
    ::  saves it replaces. Bounded by the route, not here.
    |-  ^-  form:m
    ?~  pages.act  (pure:m ~)
    ;<  ~  bind:m  (make-page root pax.i.pages.act src.i.pages.act)
    ;<  ~  bind:m  (republish-if-shared root now pax.i.pages.act src.i.pages.act)
    $(pages.act t.pages.act)
      %tmpl-save
    ::  save a page-tree as a template: copy every page's CODE under
    ::  /template/<name>, rewriting its own root path to the template root, and
    ::  leave it inert (code grub only. Templates are never evaluated).
    ::  (Instantiation is +instantiate-template, one make PER page, not a batch.)
    (copy-tree root [%page from.act] [%template /[name.act]] %.n)
      %legacy-pages
    ::  remember which page rels THIS migration triggered. Provenance matters.
    ::  A legacy page name may collide with a page the nexus published itself,
    ::  and only this record distinguishes "we put it in the vault" from "it
    ::  was already the user's".
    %^  put-file  (rf root /legacy %pages)  [/ %json]
    a+(turn rels.act |=(r=path s+(crip (pax-str r))))
      %legacy-seen
    ::  one marker for both outcomes (imported N, or dismissed with 0). Its
    ::  existence is what silences the prompt. See +legacy-mark-road.
    %^  put-file  (rf root /legacy %state)  [/ %json]
    (pairs:enjs:format ~[['imported' (numb:enjs:format imported.act)]])
      %tmpl-del
    ::  delete a template, cull its subtree. A shipped template comes back on
    ::  the next writer start (ensure-shipped-templates), which is intended.
    =/  tdir=path  (weld /template /[name.act])
    ;<  ex=?  bind:m  (peek-exists:io (rv up tdir))
    ?.  ex  (pure:m ~)
    ;<  *  bind:m  (cull-soft:io (rv up tdir))
    (pure:m ~)
      %cmd
    =/  pdir=path  (weld /page pax.act)
    ::  authoritative existence guard: no code grub -> no page (and no
    ::  evaluator fiber), so writing a cmd grub would orphan it inside a
    ::  possibly-culled dir and swallow the command (caught by review). The
    ::  route also 404s, but this closes the create-then-poke race.
    ;<  cx=?  bind:m  (peek-exists:io (rf up pdir %code))
    ?.  cx  (pure:m ~)
    ;<  sn=view:nexus  bind:m  (peek:io (rf up pdir %cmd) ~)
    =/  cur=eval-cmd:le
      ?.  ?=([%file *] sn)  [0 '' 0]
      (fall (mole |.(;;(eval-cmd:le (sang-noun:tarball sang.sn)))) [0 '' 0])
    (put-file (rf up pdir %cmd) [/lattice %eval-cmd] `eval-cmd:le`[+(seq.cur) txt.act bud.act])
      %del
    ::  cull-soft on an absent dir veto-crashes the writer (as apply-sub's
    ::  %unsub-page guards against). No-op a delete of a gone page. Also
    ::  drop the data road from the public weir so a deleted page leaves no
    ::  dangling grant.
    =/  pdir=path  (weld /page pax.act)
    ;<  ex=?  bind:m  (peek-exists:io (rv up pdir))
    ?.  ex  (pure:m ~)
    ::  unpublish FIRST: the vault copy at urb://<name> (and its /pub/index
    ::  entry) is world-readable and otherwise outlives the page forever.
    ;<  ~  bind:m
      (apply-pub root now [%del-page (spat (pub-path (crip (pax-str pax.act))))])
    ::  cull tombs the CURRENT revision but leaves every stored %firm one, so
    ::  a deleted page's bodies stayed readable via page-history and could be
    ::  resurrected onto the next page created with the same name. Drop them
    ::  first. (A folder delete culls the subtree; each page's own delete
    ::  prunes its own history, so this covers the page case exactly.)
    ::  keep=0 drops everything, so the window is irrelevant here
    ;<  ~  bind:m  (prune-hist (rf up pdir %code) 0 ~s0)
    ;<  ~  bind:m  (prune-hist (rf up pdir %data) 0 ~s0)
    ;<  *  bind:m  (cull-soft:io (rv up pdir))
    ::  re-send the public grant act AFTER the cull, so the walk inside
    ::  +send-public-how sees the deletion and the dead page's data road
    ::  leaves the group.
    ;<  ~  bind:m  (send-public-how root)
    ::  Comments live under /comments, not /page, so culling the page left them
    ::  behind: they stayed in the moderation inbox attached to a path a NEW
    ::  page could later reuse, which is the same resurrection the history
    ::  prune above exists to prevent. A folder delete lands here too, and
    ::  culling /comments/<folder> takes every page beneath it.
    ::
    ::  Guarded, because cull-soft on an absent dir veto-crashes the writer,
    ::  and most pages never had a comment.
    =/  cdir=path  (weld /comments pax.act)
    ;<  cex=?  bind:m  (peek-exists:io (rv up cdir))
    ?.  cex  (pure:m ~)
    ;<  *  bind:m  (cull-soft:io (rv up cdir))
    (pure:m ~)
      %share
    (apply-share root now pax.act mode.act)
      %share-tree
    ::  publish/unpublish a whole subtree: apply the mode to every PAGE under
    ::  pax (folders have no /data grub, so skip them). Idempotent, so
    ::  re-publishing is safe. A %private sweep revokes each page's weir too.
    =/  base=path  (weld /page pax.act)
    ;<  dn=view:nexus  bind:m  (peek:io (rv up base) ~)
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
    (ensure-dirs /page pax.act)
      %dname
    ::  the display name sits beside a page's %code or a folder's flags, as
    ::  a %name grub. '' clears it: the name typed at a rename was a valid
    ::  segment, which is its own display name, so nothing is stored.
    =/  fdir=path  (weld /page pax.act)
    ;<  ex=?  bind:m  (peek-exists:io (rv up fdir))
    ?.  ex  (pure:m ~)
    ?:  =('' name.act)
      ;<  *  bind:m  (cull-soft:io (rf up fdir %name))
      (pure:m ~)
    (put-file (rf up fdir %name) [/ %json] `json`s+name.act)
      %comments
    ::  set the comments on/off flag at pax (a page or folder). The nearest flag
    ::  at/above a page decides, so this enables/disables a whole subtree or one
    ::  page. Owner-only (an eval-action), unlike the public comment-add path.
    =/  fdir=path  (weld /page pax.act)
    ;<  ex=?  bind:m  (peek-exists:io (rv up fdir))
    ?.  ex  (pure:m ~)
    (put-file (rf up fdir %comment-on) [/lattice %comment-flag] on.act)
      %forms
    ::  set the public-form flag at pax. Same nearest-flag-wins shape as
    ::  %comments, and equally owner-only: this is the switch that makes a
    ::  clearweb page publicly writable, so it is never implicit.
    =/  fdir=path  (weld /page pax.act)
    ;<  ex=?  bind:m  (peek-exists:io (rv up fdir))
    ?.  ex  (pure:m ~)
    ;<  ~  bind:m  (put-file (rf up fdir %forms-on) [/lattice %comment-flag] on.act)
    (put-file (rf up fdir %forms-cfg) [/lattice %eval-data] `form-cfg:le`[cap.act gap.act])
      %form-hit
    ::  one accepted public submission: bump the tally. Runs in the writer so
    ::  concurrent submissions serialize (the cap check itself happens in the
    ::  request fiber, so a burst can overshoot by the number in flight).
    =/  fdir=path  (weld /page pax.act)
    ;<  ex=?  bind:m  (peek-exists:io (rv up fdir))
    ?.  ex  (pure:m ~)
    ;<  u=form-use:le  bind:m  (read-form-use pax.act)
    (put-file (rf up fdir %forms-use) [/lattice %eval-data] `form-use:le`[+(count.u) now.act])
      %form-reset
    =/  fdir=path  (weld /page pax.act)
    ;<  ex=?  bind:m  (peek-exists:io (rv up fdir))
    ?.  ex  (pure:m ~)
    (put-file (rf up fdir %forms-use) [/lattice %eval-data] `form-use:le`[0 *@da])
  ==
::  +apply-comment: store one comment under /comments/<page>/<id>. `author` is us
::  (owner writer) or the poking ship (public inbox), NEVER from the payload,
::  which can't be trusted. Rejected unless the page path is sane and has comments
::  enabled. The body is required and length-capped. Bodies are stored raw and
::  HTML-escaped at render time (they are other ships' text).
::
++  apply-comment
  |=  [root=@ud author=@p now=@da act=comment-action:lc]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  ?:  =('' body.act)  (pure:m ~)
  ::  reject an empty page path (levy is vacuously true on ~) so a comment can't
  ::  land loose in the /comments root. Value-eq, not ?=, so page.act keeps its
  ::  general `path` type (a ?= refinement makes the levy below mull-grow).
  ?:  =(~ page.act)  (pure:m ~)
  ?.  (levy page.act |=(s=@ta &(!=(%$ s) ((sane %ta) s))))  (pure:m ~)
  ;<  on=?  bind:m  (comments-on page.act)
  ?.  on  (pure:m ~)
  ::  the page must EXIST: comments-on walks flags upward, so a folder-level
  ::  comment-on would otherwise let any un-banned ship spray grubs under
  ::  invented sub-paths of a commentable site.
  ;<  ex=?  bind:m
    (peek-exists:io (rf root (weld /page page.act) %code))
  ?.  ex  (pure:m ~)
  ::  and the store is BOUNDED, for the reason the shares inbox is bounded:
  ::  anyone may poke this road, each poke files a fresh time-salted grub,
  ::  and without a cap a hostile ship grows the pier without limit. 200
  ::  per page, matching the shares cap; the owner moderates from there.
  ;<  cv=view:nexus  bind:m
    (peek:io (rv root (weld /comments page.act)) ~)
  =/  stored=@ud
    ?.  ?=([%ball *] cv)  0
    ?~  fil.ball.cv  0
    ~(wyt by contents.u.fil.ball.cv)
  ?:  (gte stored 200)  (pure:m ~)
  =/  body=@t
    ?:((gth (met 3 body.act) max-body:lc) (end [3 max-body:lc] body.act) body.act)
  =/  =comment:lc  [author now body]
  =/  id=@ta  (scot %uv (sham comment))
  =/  cbase=path  /comments
  ;<  ~  bind:m  (ensure-dirs cbase page.act)
  ;<  ~  bind:m
    (put-file (rf up (weld cbase page.act) id) [/lattice %comment] comment)
  ::  stamp /beacon/comments so the badge can ask "anything new?" for the
  ::  price of ONE grub read. Without it the only answer was the full inbox
  ::  — every comment body under /comments materialized and sorted, ~6s of
  ::  the pier's serial time — refetched on a clock whether or not anything
  ::  had arrived. Both arrival paths (owner route, remote notice) land
  ::  here, so this stamp cannot miss a comment. Deletes leave it alone:
  ::  they cannot create anything new, and the badge reads the stamp as a
  ::  CHANGE detector, not a count.
  (put-file (rf root /beacon %comments) [/ %json] (numb:enjs:format `@ud`now))
::  +comments-on: is `page` comments-enabled? The nearest `comment-on` flag grub
::  AT or ABOVE it in /page wins (like find-theme). Absent everywhere = off. One
::  flag on a site folder enables all its pages; a page can override its own.
::
++  comments-on
  |=  page=path
  =/  m  (fiber:fiber:nexus ,?)
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  |-  ^-  form:m
  =/  fdir=path  (weld /page page)
  ;<  seen=view:nexus  bind:m  (peek:io (rf up fdir %comment-on) ~)
  ?:  ?=([%file *] seen)
    (pure:m (fall (mole |.(;;(? (sang-noun:tarball sang.seen)))) %.n))
  ?~  page  (pure:m %.n)
  $(page (snip `path`page))
::  +apply-bookmark: add (prepend, dedup by url, cap) or delete a bookmark. Runs
::  in the writer since it read-modify-writes the single /bookmarks grub.
::
++  apply-bookmark
  |=  [root=@ud act=bookmark-action:lb]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ;<  cur=bookmarks:lb  bind:m  read-bookmarks
  =/  new=bookmarks:lb
    ?-  -.act
        %add
      ::  cast the prepend to the general list type. scag on a lest (non-empty
      ::  list) mull-grows.
      =/  kept=bookmarks:lb  (skip cur |=(b=bookmark:lb =(url.b url.bookmark.act)))
      (scag cap:lb `bookmarks:lb`[bookmark.act kept])
        %del  (skip cur |=(b=bookmark:lb =(url.b url.act)))
        ::  refile in place: order (= recency) is untouched, unlike a re-add
        %move
      %+  turn  cur
      |=  b=bookmark:lb
      ?.(=(url.b url.act) b b(folder folder.act))
    ==
  (put-file (rf root / %bookmarks) [/lattice %bookmarks] new)
::  +apply-history: record a visit, forget one, or clear. Runs in the writer.
::
::  Expiry happens HERE, on write, not on read. A read must never be a write
::  (the reader serves unauthenticated clearweb traffic), and pruning on every
::  mutation keeps the list bounded without a timer to maintain.
::
++  apply-history
  |=  [root=@ud now=@da act=history-action:lh]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ;<  cur=history:lh  bind:m  read-history
  ::  drop anything past the ttl before applying the action, so every write
  ::  also collects the garbage the previous fortnight left behind
  =/  live=history:lh  (skim cur |=(v=visit:lh (fresh:lh now v)))
  =/  new=history:lh
    ?-  -.act
        %clear   ~
        %forget  (skip live |=(v=visit:lh =(url.v url.act)))
        %visit
      ::  a revisit moves to the front and increments. It does not duplicate.
      =/  prior=(unit visit:lh)
        =/  hit=history:lh  (skim live |=(v=visit:lh =(url.v url.act)))
        ?~(hit ~ `i.hit)
      =/  hits=@ud  ?~(prior 1 +(hits.u.prior))
      ::  keep the FIRST title we saw if the new one is empty. A share-sheet or
      ::  bare-url visit should not blank out a title recorded earlier.
      =/  ttl=@t  ?:(=('' title.act) ?~(prior url.act title.u.prior) title.act)
      =/  kept=history:lh  (skip live |=(v=visit:lh =(url.v url.act)))
      ::  cast before scag: scag on a lest (non-empty list) mull-grows, the
      ::  same trap +apply-bookmark documents.
      (scag cap:lh `history:lh`[[url.act ttl now hits] kept])
    ==
  (put-file (rf root / %history) [/lattice %history] new)
::  +page-title-of: a page's display title for history, its first heading line,
::  falling back to the url. Gemtext and markdown both open a heading with '#',
::  so one rule covers every page kind the reader serves.
++  page-title-of
  |=  [body=@t fallback=@t]
  ^-  @t
  =/  lines=(list @t)  (to-wain:format body)
  |-  ^-  @t
  ?~  lines  fallback
  ?.  =('#' (end [3 1] i.lines))  $(lines t.lines)
  =/  t=tape  (trip i.lines)
  =/  txt=tape
    |-  ^-  tape
    ?~  t  ~
    ?:  |(=('#' i.t) =(' ' i.t))  $(t t.t)
    t
  ?~(txt fallback (crip `tape`txt))
::  +read-history: the stored visit list (newest first; ~ if none yet).
++  read-history
  =/  m  (fiber:fiber:nexus ,history:lh)
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  ;<  seen=view:nexus  bind:m  (peek:io (rf up / %history) ~)
  ?.  ?=([%file *] seen)  (pure:m ~)
  (pure:m (fall (mole |.(!<(history:lh (need-vase:tarball sang.seen)))) ~))
::  +read-bookmarks: the stored bookmark list (newest first; ~ if none yet).
::
++  read-bookmarks
  =/  m  (fiber:fiber:nexus ,bookmarks:lb)
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  ;<  seen=view:nexus  bind:m  (peek:io (rf up / %bookmarks) ~)
  ?.  ?=([%file *] seen)  (pure:m ~)
  =/  vs=vase  (need-vase:tarball sang.seen)
  =/  new=(unit bookmarks:lb)  (mole |.(!<(bookmarks:lb vs)))
  ?^  new  (pure:m u.new)
  ::  pre-folder era stored [url title] pairs. Surface them as unfiled
  ::  rather than silently dropping the whole list on the type change
  =/  old=(unit (list [url=@t title=@t]))
    (mole |.(!<((list [url=@t title=@t]) vs)))
  ?~  old  (pure:m ~)
  (pure:m (turn u.old |=([u=@t t=@t] `bookmark:lb`[u t ''])))
::  +read-recent: the up-to-`n` most-recently-edited pages, [path preview]. mtime
::  is each code grub's latest revision date (cass.da), read per page, O(pages)
::  peeks on a home load, fine for a personal ship. Add an index if it ever bites.
::
++  read-recent
  |=  n=@ud
  =/  m  (fiber:fiber:nexus ,(list [pax=path prev=@t]))
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  ::  ONE deep peek: the ball carries every code grub and the wave every cass.
  ::  The old shape listed the names then re-peeked each page, O(pages)
  ::  serialized darts on every home load, just to pick the newest n.
  ;<  sn=view:nexus  bind:m  (peek:io (rv up /page) ~)
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
::  +preview-of: a one-line, ~140-char plaintext preview of a page's source.
::  Leading markdown '#'/spaces dropped, whitespace flattened to single spaces.
::
++  preview-of
  |=  code=@t
  ^-  @t
  ::  a content page (md/css/js/gmi/text) stores its raw body wrapped in a builder
  ::  gate. Unwrap it so the preview is the actual content, not the hoon wrapper
  ::  (a raw hoon builder has nothing to unwrap. Preview its source as-is).
  =/  raw=@t
    =/  un=(unit [builder=@tas body=@t])  (unwrap-content code)
    ?~(un code body.u.un)
  =/  in=tape  (trip raw)
  =.  in  |-(?~(in in ?:(?=(?(%'#' %' ') i.in) $(in t.in) in)))
  =/  flat=tape  (turn (scag 200 in) |=(c=@tD ?:((lte c ' ') ' ' c)))
  (crip (scag 140 flat))
::  +apply-share: set one page's sharing preset, the shared body of the %share
::  and %share-tree eval-actions, so per-page and per-tree can't drift. weir road
::  first (covers the grub before it exists), then gain the current data if any
::  (the evaluator re-gains on each later write). Idempotent.
::
::  +apply-share: set a page's sharing preset, and make BOTH surfaces match it.
::
::  %private     on neither: no vault copy (so no ship can read it over ames),
::               data grub un-gained, no /c/ route.
::  %shared      vault copy published + gained, so peers resolve urb://…/<name>.
::  %clearweb    the same, PLUS the unauthenticated /c/ route.
::
::  Setting the preset used to touch only the data grub's gain/weir, which is
::  not the surface anyone browses: urb:// resolves through /pub/vault. So a
::  clearweb page was reachable on the web and 404 over ames, and a page could
::  sit in the vault (readable by any ship, since /pub is publicly granted)
::  while still labelled private. Drive the vault from the preset instead.
++  apply-share
  |=  [root=@ud now=@da rel=path mode=share-mode:le]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  =/  pdir=path  (weld /page rel)
  ;<  cx=?  bind:m  (peek-exists:io (rf up pdir %code))
  ?.  cx  (pure:m ~)
  =/  data-road=road:tarball  (rf up pdir %data)
  =/  pub=?  !=(%private mode)
  ;<  dx=?  bind:m  (peek-exists:io data-road)
  ;<  ~  bind:m  ?:(dx (gain:io data-road pub) (pure:m ~))
  ;<  ~  bind:m  (put-file (rf up pdir %share) [/lattice %eval-data] mode)
  ::  the grant act walks share grubs, so it runs AFTER the mode write and
  ::  reflects this share (or unshare) immediately.
  ;<  ~  bind:m  (send-public-how root)
  =/  key=@t  (spat (pub-path (crip (pax-str rel))))
  ?.  pub  (apply-pub root now [%del-page key])
  ::  publish the page's own output. A page whose data is not a cord (a
  ::  computed noun) has no gemtext form, so it keeps its preset without a
  ::  vault copy rather than publishing something meaningless.
  ;<  dn=view:nexus  bind:m  (peek:io data-road ~)
  ?:  ?=([%file *] dn)
    =/  body=(unit @t)  (mole |.(;;(@t (sang-noun:tarball sang.dn))))
    ?~  body  (pure:m ~)
    (apply-pub root now [%save-page key u.body])
  ::  no computed data yet — a freshly-made page (a move lands here: %share
  ::  is queued right behind %make, and the evaluator computes /data later).
  ::  Publish from the code src, exactly as +republish-if-shared does; the
  ::  evaluator's eventual output republishes over this if it differs.
  ;<  cv=view:nexus  bind:m  (peek:io (rf up pdir %code) ~)
  ?.  ?=([%file *] cv)  (pure:m ~)
  =/  src=(unit @t)  (mole |.(;;(@t (sang-noun:tarball sang.cv))))
  ?~  src  (pure:m ~)
  =/  un=(unit [builder=@tas body=@t])  (unwrap-content u.src)
  ?~  un  (pure:m ~)
  (apply-pub root now [%save-page key body.u.un])
::  +republish-if-shared: refresh a page's published vault copy after a write.
::  urb:// names a LIVE page (docs/urls.md), but until this arm the vault copy
::  was a snapshot taken only when the share preset was SET. Every later edit
::  left urb:// readers (own front door included) on the stale body forever.
::
::  The body comes from the make's own src (unwrapped), NOT the data grub.
::  The evaluator recomputes data AFTER the writer moves on, so a data peek
::  here publishes the PREVIOUS revision (verified: one save behind).
::  ponytail: computed (hoon/index) pages keep share-time snapshots. Their
::  body lands async. A data-keep publisher fiber is the upgrade path.
::  Non-content saves cost nothing. Private content pages cost one peek.
::
++  republish-if-shared
  |=  [root=@ud now=@da rel=path src=@t]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  =/  un=(unit [builder=@tas body=@t])  (unwrap-content src)
  ?~  un  (pure:m ~)
  =/  pdir=path  (weld /page rel)
  ;<  sx=?  bind:m  (peek-exists:io (rf up pdir %share))
  ?.  sx  (pure:m ~)
  ;<  sv=view:nexus  bind:m  (peek:io (rf up pdir %share) ~)
  ?.  ?=([%file *] sv)  (pure:m ~)
  =/  mode=(unit share-mode:le)
    (mole |.(;;(share-mode:le (sang-noun:tarball sang.sv))))
  ?~  mode  (pure:m ~)
  ?:  ?=(%private u.mode)  (pure:m ~)
  (apply-pub root now [%save-page (spat (pub-path (crip (pax-str rel)))) body.u.un])
::  +make-page: create a page at `pax` under /page with the given code, the
::  shared body of the %make action and template instantiation. cmd + deps
::  first (the code grub's fiber reads both at spawn), then the code.
::
::  +history-keep / +know-keep / +data-keep: revisions retained per grub.
::  Autosave writes one revision per typing pause, so every GAINED grub needs
::  a ceiling or the pier archives every keystroke forever.
::    page source / know entries: the user-facing history surfaces, so deep
::    enough to undo a bad session.
::    page data: recomputed on every command, dependency wave, timer tick and
::    public form submission, with NO history UI. Keep only enough to debug.
++  history-keep  50
++  know-keep     50
++  data-keep     3
::  +history-window: two revisions closer together than this are keystroke-scale
::  intermediates, not history. The trail behind the head gets collapsed so the
::  KEPT revisions stay roughly this far apart. Nothing is ever lost from the
::  document: every save still writes, and the head is always current. Only the
::  superseded intermediates go.
::
::  A count-only cap was not enough. Editing through the lattice-fs mount turns
::  one editor save into several write() calls (the kernel picks the chunking,
::  not us), each a %make and each a revision, so all 50 slots filled in
::  seconds and "history" spanned under a minute. Throttling here rather than in
::  the editor's debounce covers every writer: browser, fs mount, MCP, raw API.
++  history-window  ~m5
::  +prune-hist: drop a grub's revision tail past `keep`.
::
::  Uses +born (metadata only: cass + tags + tombstone flag) rather than +peep,
::  which hydrates every stored BODY just to count them. On a 50-revision page
::  that is 50 full documents read per save. Tombstones are filtered so the
::  count matches what +peep-based callers and page-history report.
::
++  prune-hist
  |=  [road=road:tarball keep=@ud window=@dr]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ;<  bo=(each (list [=cass:clay tags=(set @t) tomb=?]) tang)  bind:m  (born:io road)
  ?:  ?=(%| -.bo)  (pure:m ~)
  ::  live revisions, NEWEST FIRST. Both passes below want that order, and one
  ::  +born read feeds both so a save costs no extra dart than it used to.
  =/  live=(list cass:clay)
    %+  sort
      %+  murn  p.bo
      |=  [c=cass:clay tags=(set @t) tomb=?]
      ^-  (unit cass:clay)
      ?:(tomb ~ `c)
    |=([a=cass:clay b=cass:clay] (gth ud.a ud.b))
  ::  keep=0 means drop the lot (used by delete). Guard it explicitly. The
  ::  general path below computes (dec keep), and dec 0 crashes, which would
  ::  have taken the writer down on every page delete.
  ?:  =(0 keep)
    ?~  live  (pure:m ~)
    (lose:io road [%numb ~ ~])
  ::  ── time coalesce ──
  ::  live is [head, prev, anchor, ...]. Drop `prev` when it sits inside one
  ::  window of `anchor`, i.e. it is an intermediate between two kept points.
  ::
  ::  Comparing prev against the HEAD instead is the obvious version and it is
  ::  wrong. The thing compared against is replaced on every save, so a long
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
  |=  [root=@ud pax=path src=@t]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  =/  pdir=path  (weld /page pax)
  ::  ONE existence probe. An overwrite (code present) already has its dirs,
  ::  cmd and deps from creation. The old per-save re-probing of each was
  ::  3+ wasted darts on every autosave. A half-created page (crash between
  ::  scaffold and code) just re-runs the scaffold. put-file is idempotent.
  ;<  ex=?  bind:m  (peek-exists:io (rf up pdir %code))
  ;<  ~  bind:m
    ?:  ex  (pure:m ~)
    ;<  ~  bind:m  (ensure-dirs /page pax)
    ;<  ~  bind:m  (put-file (rf up pdir %cmd) [/lattice %eval-cmd] `eval-cmd:le`[0 '' 0])
    (put-file (rf up pdir %deps) [/lattice %eval-deps] `(list path)`~)
  ;<  ~  bind:m  (put-file (rf up pdir %code) [/lattice %page] src)
  ::  gain the code grub so every save is a kept %firm revision. That is
  ::  what page-history / page-source-at read. Privacy is unchanged. gain
  ::  makes a grub namespace-addressable but cross-ship reads stay weir-gated
  ::  deny-all, the same model the know vault uses (every private entry
  ::  gained, for exactly this history).
  ;<  ~  bind:m  (gain:io (rf up pdir %code) %.y)
  (prune-hist (rf up pdir %code) history-keep history-window)
::  +rewrite-root: replace the path-prefix `from` with `to` in code, only where
::  `from` ends at a path boundary (/ ) space " ] , or end), so a short root
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
  ::  NEWLINE, CR, all <= ' '), or a structural close/open ( ) ( [ ] " , ).
  =/  bnd=?
    ?~  aft  %.y
    ?|((lte i.aft ' ') ?=(?(%'/' %')' %'(' %'[' %']' %'"' %',') i.aft))
  ::  `from` starts with '/', so the match always lands on a '/'; but that '/'
  ::  must be the START of a path literal, not a separator mid-path. So require a
  ::  boundary BEFORE it too: start-of-code, whitespace/control, or a structural
  ::  open ( [ " , . Else '/data/site' (or the 2nd seg of '/site/site') would be
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
  |=  [root=@ud src=[base=@tas rel=path] dst=[base=@tas rel=path] live=?]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  =/  src-root=path  (weld /[base.src] rel.src)
  =/  from-str=tape  (spud rel.src)
  =/  to-str=tape    (spud rel.dst)
  ;<  dn=view:nexus  bind:m  (peek:io (rv up src-root) ~)
  ?.  ?=([%ball *] dn)  (pure:m ~)
  =/  rels=(list path)
    %+  murn  (collect-tree ball.dn ~)
    |=([pax=path page=?] ?:(page `pax ~))
  |-  ^-  form:m
  ?~  rels  (pure:m ~)
  ;<  cn=view:nexus  bind:m  (peek:io (rf up (weld src-root i.rels) %code) ~)
  =/  code=@t
    ?.  ?=([%file *] cn)  ''
    (fall (mole |.(;;(@t (sang-noun:tarball sang.cn)))) '')
  =/  newcode=@t  (crip (rewrite-root (trip code) from-str to-str))
  ;<  ~  bind:m
    ?:  live
      (make-page root (weld rel.dst i.rels) newcode)
    =/  ddir=path  (weld /[base.dst] (weld rel.dst i.rels))
    ;<  ~  bind:m  (ensure-dirs /[base.dst] (weld rel.dst i.rels))
    (put-file (rf root ddir %code) [/lattice %page] newcode)
  $(rels t.rels)
::  +rewrite-wikilinks: rewrite [[from]] and [[from/...]] references in code
::  text to the new name, the bare-name form wikilinks use (+rewrite-root
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
::  action. The same reasoning as +instantiate-template: a batch make in one
::  writer transaction arms dep-keeps that never establish. Returns ~ when
::  nothing exists at src. `count is the number of pages moved (0 = an empty
::  folder, still a successful move).
::
++  move-pages
  |=  [from=path to=path]
  =/  m  (fiber:fiber:nexus ,(unit @ud))
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  =/  sdir=path  (weld /page from)
  =/  from-str=tape   (spud from)
  =/  to-str=tape     (spud to)
  =/  from-bare=tape  (pax-str from)
  =/  to-bare=tape    (pax-str to)
  ;<  dn=view:nexus  bind:m  (peek:io (rv up sdir) ~)
  ?.  ?=([%ball *] dn)  (pure:m ~)
  =/  all=(list [pax=path page=?])  (collect-tree ball.dn ~)
  =/  dirs=(list path)
    (sort (murn all |=([pax=path page=?] ?:(page ~ `pax))) aor)
  =/  rels=(list path)
    (sort (murn all |=([pax=path page=?] ?:(page `pax ~))) aor)
  ::  structure first, parents before children, preserves empty subfolders.
  ::  Display names of the root and every subfolder ride along after the
  ::  mkdirs (pages carry theirs in the per-page loop below).
  ;<  dacts=(list eval-action:le)  bind:m  (dname-acts sdir to [`path`~ dirs])
  =/  todo=(list eval-action:le)
    %+  weld
      ^-  (list eval-action:le)
      [[%mkdir to] (turn dirs |=(p=path `eval-action:le`[%mkdir (weld to p)]))]
    dacts
  =/  count=@ud  0
  |-  ^-  form:m
  ?^  todo
    ;<  ~  bind:m  (poke-eval i.todo)
    $(todo t.todo)
  ?~  rels
    ;<  ~  bind:m  (poke-eval [%del from])
    (pure:m `count)
  =/  pdir=path  (weld sdir i.rels)
  ;<  cn=view:nexus  bind:m  (peek:io (rf up pdir %code) ~)
  =/  code=@t
    ?.  ?=([%file *] cn)  ''
    (fall (mole |.(;;(@t (sang-noun:tarball sang.cn)))) '')
  ;<  mode=share-mode:le  bind:m  (read-share pdir)
  ;<  dn=(unit @t)  bind:m  (read-dname pdir)
  =/  dst=path  (weld to i.rels)
  =/  newcode=@t
    %-  crip
    %^  rewrite-wikilinks
        (rewrite-root (trip code) from-str to-str)
      from-bare
    to-bare
  =/  acts=(list eval-action:le)
    :-  [%make dst newcode]
    %+  weld
      ^-  (list eval-action:le)  ?~(dn ~ [%dname dst u.dn]~)
    ^-  (list eval-action:le)
    ?:(=(%private mode) ~ [%share dst mode]~)
  $(todo acts, rels t.rels, count +(count))
::  +instantiate-template: create a live page-tree from a template. Runs in a
::  REQUEST fiber and pokes one %make PER page (a separate writer transaction
::  each), in sorted order, so every page commits before the next and its
::  evaluator spawns against a settled tree. This is why it is NOT a batch
::  writer action: pages made in one transaction arm dep-keeps that never
::  establish (the tree isn't committed yet), leaving the copies non-reactive.
::
++  instantiate-template
  |=  [name=@tas to=path]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  =/  troot=path    (weld /template /[name])
  =/  from-str=tape  (spud /[name])
  =/  to-str=tape    (spud to)
  ;<  dn=view:nexus  bind:m  (peek:io (rv up troot) ~)
  ?.  ?=([%ball *] dn)  (pure:m ~)
  =/  rels=(list path)
    %+  sort
      %+  murn  (collect-tree ball.dn ~)
      |=([pax=path page=?] ?:(page `pax ~))
    aor
  |-  ^-  form:m
  ?~  rels  (pure:m ~)
  ;<  cn=view:nexus  bind:m  (peek:io (rf up (weld troot i.rels) %code) ~)
  =/  code=@t
    ?.  ?=([%file *] cn)  ''
    (fall (mole |.(;;(@t (sang-noun:tarball sang.cn)))) '')
  =/  newcode=@t  (crip (rewrite-root (trip code) from-str to-str))
  ;<  ~  bind:m  (poke-eval [%make (weld to i.rels) newcode])
  $(rels t.rels)
::  +page-code: the stored hoon code for a page of a given kind: an index-type
::  page's generated auto-index, a content builder's wrapped body, else raw hoon.
::  Shared by page-save and template laydown.
::
++  page-code
  |=  [pax=path kind=@tas body=@t]
  ^-  @t
  ?:  =(%index kind)  (make-folder-index pax)
  ?:((~(has in content-builders) kind) (wrap-content kind body) body)
::  +ensure-shipped-templates: on writer start, lay down the built-in templates
::  under /template/ if absent (idempotent, never overwrites. A user can edit
::  or replace them). Writes inert code grubs. The tree is covered by an on-load
::  row so it survives reload.
::
++  ensure-shipped-templates
  |=  root=@ud
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
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
  =/  pdir=path  (weld /template prel)
  ::  per-page: skip a page that already exists (never overwrite a user edit,
  ::  and a laydown interrupted after some pages completes on the next start),
  ::  else write it.
  ;<  ex=?  bind:m  (peek-exists:io (rf up pdir %code))
  ?:  ex  $(pages t.pages)
  =/  code=@t  (page-code prel kind.i.pages body.i.pages)
  ;<  ~  bind:m  (ensure-dirs /template prel)
  ;<  ~  bind:m  (put-file (rf up pdir %code) [/lattice %page] code)
  $(pages t.pages)
::  +public-grp: the public usergroup's storage dir. Grubbery names usergroup
::  dirs with a `.grp` suffix (+grp-storage-path in app/grubbery.hoon), a
::  FOURTH framework drift past seen->view, loader ver->manifest and
::  bowl->bowl.sig. We wrote to /usergroups/public, which does not exist, so
::  the peek-exists guard below failed and EVERY share grant silently no-opped:
::  cross-ship reads of shared/clearweb pages were denied. Clearweb over HTTP
::  was unaffected, which is why it went unnoticed.
::
++  public-grp  ^-(path /sys/ames/usergroups/'public.grp')
::  +read-share: a page's sharing preset grub, %private if absent/malformed.
::
++  read-share
  |=  pdir=path
  =/  m  (fiber:fiber:nexus ,share-mode:le)
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  ;<  sn=view:nexus  bind:m  (peek:io (rf up pdir %share) ~)
  ?.  ?=([%file *] sn)  (pure:m %private)
  (pure:m (fall (mole |.(;;(share-mode:le (sang-noun:tarball sang.sn)))) %private))
::  +read-show-mode: a page's render mode grub, %text if absent/malformed.
::
++  read-show-mode
  |=  pdir=path
  =/  m  (fiber:fiber:nexus ,view-mode:pg)
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  ;<  sn=view:nexus  bind:m  (peek:io (rf up pdir %show) ~)
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
  ;<  up=@ud  bind:m  nexus-up
  ;<  sn=view:nexus  bind:m  (peek:io (rf up pdir %wake) ~)
  ?.  ?=([%file *] sn)  (pure:m ~)
  (pure:m (fall (mole |.(;;((unit @dr) (sang-noun:tarball sang.sn)))) ~))
::  +read-eval-cmd / +read-eval-deps: tolerant grub reads (absent or
::  malformed -> the zero value; a page never crashes its evaluator).
::
::  +recompute-cap: max RAPID consecutive reruns before the evaluator parks a
::  page (cycle / runaway guard). Only reruns closer together than +rerun-gap
::  count, so a legit page reacting to spaced-out updates never hits it. 32 is
::  far above any real reactive chain and keeps the runaway burst short.
::
++  recompute-cap  ^-(@ud 32)
::  +rerun-gap: reruns landing closer than this are "rapid" (part of a runaway
::  burst) and accumulate. A larger gap is a legit update and resets the count.
::
++  rerun-gap  ^-(@dr ~s1)
::  +poke-cap: max page-to-page pokes one run may emit (flood guard).
::
++  poke-cap  ^-(@ud 16)
::  +poke-budget-max: max depth of a page-to-page poke chain. A user/dep/timer
::  trigger starts a run with this budget. Each poke it emits carries budget-1,
::  so any chain (a cycle included) terminates after this many hops,
::  independent of timing (poke round-trips are too slow for the rate cap).
::
++  poke-budget-max  ^-(@ud 8)
++  read-eval-cmd
  |=  pdir=path
  =/  m  (fiber:fiber:nexus ,eval-cmd:le)
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  ;<  sn=view:nexus  bind:m  (peek:io (rf up pdir %cmd) ~)
  ?.  ?=([%file *] sn)  (pure:m [0 '' 0])
  (pure:m (fall (mole |.(;;(eval-cmd:le (sang-noun:tarball sang.sn)))) [0 '' 0]))
::  +read-eval-seen / +write-eval-seen: the last-PROCESSED command seq, stored
::  as a bare @ud (reusing the eval-data marc, it's a noun grub). /seen is
::  never kept, so writing it wakes no fiber. Absent -> 0.
::
++  read-eval-seen
  |=  pdir=path
  =/  m  (fiber:fiber:nexus ,@ud)
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  ;<  sn=view:nexus  bind:m  (peek:io (rf up pdir %seen) ~)
  ?.  ?=([%file *] sn)  (pure:m 0)
  (pure:m (fall (mole |.(;;(@ud (sang-noun:tarball sang.sn)))) 0))
++  write-eval-seen
  |=  [pdir=path seq=@ud]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  (put-file (rf up pdir %seen) [/lattice %eval-data] seq)
++  read-eval-deps
  |=  pdir=path
  =/  m  (fiber:fiber:nexus ,(list path))
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  ;<  sn=view:nexus  bind:m  (peek:io (rf up pdir %deps) ~)
  ?.  ?=([%file *] sn)  (pure:m ~)
  (pure:m (fall (mole |.(;;((list path) (sang-noun:tarball sang.sn)))) ~))
::  +view-src: if a dep path is a VIEW dependency on one of our OWN pages
::  (/apps/lattice.lattice_app/page/<name>/view), the source page's dir; else ~.
::  A view-dep resolves to the source page's RENDERED html rather than its raw
::  data (composition, docs/pages.md). Own-tree only by construction. A foreign
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
  ;<  up=@ud  bind:m  nexus-up
  ?~  deps  (pure:m armed)
  ?:  (~(has in armed) i.deps)  $(deps t.deps)
  ?:  =(~ i.deps)  $(deps t.deps)
  =/  src=(unit path)  (view-src i.deps)
  ?^  src
    ;<  *  bind:m  (keep:io /ev (rf up u.src %data) ~)
    ;<  *  bind:m  (keep:io /ev (rf up u.src %show) ~)
    $(deps t.deps, armed (~(put in armed) i.deps))
  =/  n=@ud  (dec (lent i.deps))
  =/  file-road=road:tarball  (rf up (scag n i.deps) (snag n i.deps))
  ;<  fsn=view:nexus  bind:m  (peek:io file-road ~)
  ?:  ?=([%file *] fsn)
    ;<  *  bind:m  (keep:io /ev file-road ~)
    $(deps t.deps, armed (~(put in armed) i.deps))
  ::  not a file: a DIRECTORY dep keeps on the dir road so a child add/remove
  ::  re-runs us. If it is neither (a not-yet-created grub), keep the file road
  ::  so a later write of that grub still fires. Mirrors read-dep-vals.
  ;<  dsn=view:nexus  bind:m  (peek:io (rv up i.deps) ~)
  =/  keep-road=road:tarball  ?:(?=([%ball *] dsn) (rv up i.deps) file-road)
  ;<  *  bind:m  (keep:io /ev keep-road ~)
  $(deps t.deps, armed (~(put in armed) i.deps))
::  +read-dep-vals: resolve each dep to its current value. A data dep gives the
::  grub's raw noun (~ if absent); a VIEW dep gives the source page's RENDERED
::  html fragment as a @t (composition: the fragment is welded into this page's
::  own html). render-shown runs on our OWN page data only (view-src is own-tree).
::
++  read-dep-vals
  |=  deps=(list path)
  =/  m  (fiber:fiber:nexus ,(list [path *]))
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  ?~  deps  (pure:m ~)
  ?:  =(~ i.deps)  $(deps t.deps)
  =/  src=(unit path)  (view-src i.deps)
  ?^  src
    ;<  dsn=view:nexus       bind:m  (peek:io (rf up u.src %data) ~)
    ;<  vmode=view-mode:pg   bind:m  (read-show-mode u.src)
    ;<  rest=(list [path *])  bind:m  (read-dep-vals t.deps)
    =/  frag=@t
      ?.  ?=([%file *] dsn)  ''
      ::  a composed view fragment is rendered ONCE at eval time and stored in
      ::  the composing page's data, then served on both surfaces, so no base
      ::  is universally right. /c/ is the useful one. Composition (dashboards,
      ::  indexes) is what gets published. Wikilinks inside an embedded
      ::  fragment therefore always point at the public surface.
      (crip (render-shown sang.dsn vmode "/apps/lattice/c/"))
    (pure:m [[i.deps frag] rest])
  =/  n=@ud  (dec (lent i.deps))
  ;<  sn=view:nexus  bind:m  (peek:io (rf up (scag n i.deps) (snag n i.deps)) ~)
  ?:  ?=([%file *] sn)
    ::  a file grub -> its raw noun.
    ;<  rest=(list [path *])  bind:m  (read-dep-vals t.deps)
    (pure:m [[i.deps (sang-noun:tarball sang.sn)] rest])
  ::  not a file -> a DIRECTORY dep resolves to its tree listing (a
  ::  (list [pax=path page=?]) of pages+folders under it, paths relative to the
  ::  dir), so a page can enumerate a structured subtree. ~ if it is neither.
  ;<  dn=view:nexus  bind:m  (peek:io (rv up i.deps) ~)
  ;<  rest=(list [path *])  bind:m  (read-dep-vals t.deps)
  =/  val=*  ?.(?=([%ball *] dn) ~ (collect-tree ball.dn ~))
  (pure:m [[i.deps val] rest])
::  +eval-run: one run of a compiled page: build the env vase (typed via
::  slop, so the gate's declared sample nest-checks), slam inside mule,
::  land the product. dat=~ means no change. A changed dep list is
::  persisted (the deps grub is on the /ev wire, so the loop re-arms).
::
++  eval-run
  |=  [pdir=path bild=vase cmd=(unit @t) deps=(list path) bud=@ud]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  ;<  now=@da  bind:m  bowl-now
  ;<  dsn=view:nexus  bind:m  (peek:io (rf up pdir %data) ~)
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
    ;<  ~  bind:m  (put-file (rf up pdir %err) [/lattice %page] (render-tang 'run failed:' p.res))
    ::  a broken run stops any timer.
    (put-file (rf up pdir %wake) [/lattice %eval-data] `(unit @dr)`~)
  ;<  ~  bind:m  (put-file (rf up pdir %err) [/lattice %page] '')
  ;<  ~  bind:m
    ?~  dat.p.res  (pure:m ~)
    ;<  ~  bind:m  (put-file (rf up pdir %data) [/lattice %eval-data] u.dat.p.res)
    ::  record the render mode next to the data (read by the page view).
    ;<  ~  bind:m  (put-file (rf up pdir %show) [/lattice %eval-data] show.p.res)
    ::  a shared page's data must stay gained across recomputes. Gain is
    ::  per-revision (like apply-pub re-gaining on every save).
    ;<  mode=share-mode:le  bind:m  (read-share pdir)
    ?:  =(%private mode)  (pure:m ~)
    ;<  ~  bind:m  (gain:io (rf up pdir %data) %.y)
    ::  a gained data grub keeps EVERY recompute forever otherwise. A timer
    ::  page, or a public form anyone can submit to, would grow the pier
    ::  without bound. Data has no history UI, so keep only a debugging tail.
    ::  data has no history UI and keep=3 already, no window needed
    (prune-hist (rf up pdir %data) data-keep ~s0)
  ::  send this run's page-to-page pokes with the run's remaining budget
  ::  (capped per run so one page can't flood the writer).
  ;<  ~  bind:m  (emit-pokes bud (scag poke-cap pokes.p.res))
  ;<  ~  bind:m
    ?:  =(dep.p.res deps)  (pure:m ~)
    (put-file (rf up pdir %deps) [/lattice %eval-deps] dep.p.res)
  ::  record the timer request for the loop to arm, clamped so it can't rerun
  ::  faster than the rate window (~ = no timer). The loop reads /wake after
  ::  this run; /wake is not on the /ev wire, so writing it is not a self-wave.
  =/  wake=(unit @dr)  ?~(wake.p.res ~ `(max u.wake.p.res rerun-gap))
  (put-file (rf up pdir %wake) [/lattice %eval-data] wake)
::  +emit-pokes: deliver each [page-name command] to the writer (which bumps
::  that page's cmd grub), carrying a DECREMENTED budget so a poke chain (or
::  cycle) terminates at a fixed depth. bud=0 drops them. The chain ends. A
::  poke to a nonexistent page is a safe no-op (apply-eval %cmd guards on the
::  code grub existing).
::
++  emit-pokes
  |=  [bud=@ud pokes=(list [name=@ta txt=@t])]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ?:  =(0 bud)  (pure:m ~)
  ?~  pokes  (pure:m ~)
  ;<  ~  bind:m  (poke-eval-abs [%cmd ~[name.i.pokes] txt.i.pokes (dec bud)])
  $(pokes t.pokes)
++  poke-sub
  |=  act=sub-action:lp
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  (poke:io [%| 2 %& ~ %'main.sig'] [[/lattice %sub-action] act])
::  +parse-import: decode a /know-all export ({items:[{key,body,updated,tags}]})
::  into [key entry] pairs for a verbatim %import. Mirrors know-entry-json's shape.
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
::  so this is serial+synchronous. Every entry is applied before the next.
++  import-know-loop
  |=  [items=(list [key=@t entry=know-entry:lk]) cnt=@ud]
  =/  m  (fiber:fiber:nexus ,@ud)
  ^-  form:m
  ?~  items  (pure:m cnt)
  ;<  ~  bind:m  (poke-know [%import key.i.items entry.i.items])
  (import-know-loop t.items (add cnt 1))
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
::  +tang-text: render a tang as one cord, no per-tank separator. The only
::  caller left is /grub-save, which reports a mark conversion failure to the
::  editor as plain text.
++  tang-text
  |=  =tang
  ^-  @t
  (crip (zing (turn tang |=(=tank ~(ram re tank)))))
::  +body-cap: max page bytes fed to the tokenizer. end truncates to the low
::  body-cap bytes (a no-op for a smaller body), so one enormous page cannot
::  dominate a rebuild. Tokenization is lossy anyway.
::
++  body-cap  ^-(@ud 1.048.576)
::  +sub-apply-wave: act on ONE wave of a subscribed page (mesa D2). The wave
::  (initial bond or edit) carries the kept gmi grub's cass, which IS the rev
::  the publisher last grew a namespace binding at. For a save that binding
::  is a body, [%gmi @t]. For a delete it is a tombstone, [%del ''].
::  grubbery's born is a high-water mark, so a deleted grub NEVER drops out
::  of the wave's file map. It reads cass N+1, the [%temp ~] hist entry the
::  vault cull appended, which is why the delete signal must be a binding
::  the keen can hit, not an absent cass. The bulk fetch goes over the
::  namespace: one %keen at /pub/page/<rel>/<rev>, answered by the peer's
::  kernel out of gall's scry farm. No weir negotiation, no per-reader work
::  in the peer's %grubbery, and the signed answer is relay-cacheable. The
::  kiln/clay shape: notify over the flow, bulk over the namespace.
::
::  Returns the new lrev. A keen MISS (timeout, unbound spur, unknown mark)
::  retries ONCE after a short drain-sleep, then gives up WITHOUT advancing
::  lrev. The next wave (or a resubscribe) then retries the fetch instead of
::  skipping the rev as a duplicate forever. Bounded at one extra attempt
::  per wave, no polling. Against a non-mirroring publisher every wave
::  misses (this reader is mesa-only by design). r=0 means the grub has never
::  existed in the peer's pub vault (a sub armed before the first share).
::  Nothing to do until a wave with a real cass arrives.
::
++  sub-apply-wave
  |=  [pub=@p rel=path wav=wave:nexus lrev=@ud]
  =/  m  (fiber:fiber:nexus ,@ud)
  ^-  form:m
  =/  wfil=(map @ta cass:clay)  ?~(fil.wav ~ file.u.fil.wav)
  =/  c=(unit cass:clay)  (~(get by wfil) %gmi)
  =/  r=@ud  ?~(c 0 ud.u.c)
  ?:  =(0 r)  (pure:m lrev)
  ?.  (gth r lrev)  (pure:m lrev)
  =/  try=@ud  0
  |-
  ;<  pg=(unit [p=@tas q=@t])  bind:m  (keen-page-raw pub rel r)
  ?~  pg
    ?:  (gte try 1)  (pure:m lrev)
    ;<  ~  bind:m  (sleep-draining ~s2)
    $(try +(try))
  ?:  =(%del p.u.pg)
    ::  DELETE: the publisher grew a tombstone at the post-cull cass. lrev
    ::  advances to r so a later re-publish (cass r+1 and up) still registers.
    (pure:m r)
  ?.  =(%gmi p.u.pg)  (pure:m lrev)
  ::  SAVE/EDIT: the fetch above is what proves the wave carried a real body,
  ::  so lrev may advance past it.
  (pure:m r)
::  +page-src: a page's current stored source (the WRAPPED src, so re-saving
::  it reproduces the page byte-for-byte, kind included), ~ if absent.
++  page-src
  |=  rel=path
  =/  m  (fiber:fiber:nexus ,(unit @t))
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  =/  pdir=path  (weld /page rel)
  ;<  cv=view:nexus  bind:m  (peek:io (rf up pdir %code) ~)
  ?.  ?=([%file *] cv)  (pure:m ~)
  (pure:m (mole |.(;;(@t (sang-noun:tarball sang.cv)))))
::  +conflict-name: where a conflict's LOSING body is preserved as a real
::  page. NOT left to revision history. The firm keep coalesces rapid
::  revisions (three quick writes kept revs [3,1] and pruned 2 in testing),
::  so "recover it from history" is false exactly when the overwrite came
::  quickly. A page in the tree is visible, recoverable and deletable, and
::  needs no machinery that does not already exist.
++  conflict-name
  |=  [nam=@t prev=@ud]
  ^-  @t
  %-  crip
  ;:  weld
    "conflicts/"
    %+  turn  (trip nam)
    |=(c=@tD ?:(=('/' c) '-' c))
    "-rev"
    ::  plain digits, NOT +scow. %ud renders "1.234" with dot separators,
    ::  and autosave rev numbers pass 1000 within a few sessions
    (num-tape:pg prev)
  ==
::  +page-rev: the current revision of one page's code grub, 0 if absent.
::  One dir peek; the wave carries the cass (same read fs-dump-json uses),
::  which is far lighter than peep %numb walking every historical revision.
++  page-rev
  |=  rel=path
  =/  m  (fiber:fiber:nexus ,@ud)
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  =/  pdir=path  (weld /page rel)
  ;<  dv=view:nexus  bind:m  (peek:io (rv up pdir) ~)
  ?.  ?=([%ball *] dv)  (pure:m 0)
  =/  wfil=(map @ta cass:clay)  ?~(fil.wave.dv ~ file.u.fil.wave.dv)
  =/  c=(unit cass:clay)  (~(get by wfil) %code)
  (pure:m ?~(c 0 ud.u.c))
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
  |=  [up=@ud raw=@t]
  ^-  (unit road:tarball)
  =/  pp=(each path tang)  (mule |.((pub-path raw)))
  ?:  ?=(%| -.pp)  ~
  =/  vr=(unit vrail:lp)  (key-to-rail:lp /pub/vault p.pp)
  ?~  vr  ~
  `(rf up pax.u.vr nom.u.vr)
::  +know-hist-road: the ABSOLUTE road of a know key's entry grub, for reading its
::  revision history. A live key's grub is under /know/vault; a DELETED key was
::  MOVED to /know/trash-vault (%del moves the grub, it doesn't tomb in place), so
::  its history lives there instead. Resolve live-first, then trash. peep + peek-at
::  MUST use the same road. A rev from one road's history bails peek-at on the other.
::  ~ if the key is unparseable or exists in neither vault. The `trashed` flag lets
::  the UI label a deleted key's (shallow, one-snapshot) history.
::
++  know-hist-road
  |=  raw=@t
  =/  m  (fiber:fiber:nexus ,(unit [road=road:tarball trashed=?]))
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  =/  ko=(unit path)  (know-key raw)
  ?~  ko  (pure:m ~)
  =/  live=road:tarball   (entry-road up /know/vault u.ko)
  =/  trash=road:tarball  (entry-road up /know/trash-vault u.ko)
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
::  share grub (and the wave every grub's cass), so the old shape (deep peek,
::  discard the ball, then TWO more darts per page (code re-peek + read-share))
::  was pure waste that degraded the route linearly as pages accumulate.
::  Walk in place, exactly like +fs-dump-json.
++  fs-tree-json
  =/  m  (fiber:fiber:nexus ,json)
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  ;<  sn=view:nexus  bind:m  (peek:io (rv up /page) ~)
  ?.  ?=([%ball *] sn)  (pure:m (pairs:enjs:format ~[['nodes' a+~]]))
  =/  nodes=(list [pax=path j=json])  (tree-walk ball.sn wave.sn ~)
  =/  srt  (sort nodes |=([a=[pax=path *] b=[pax=path *]] (aor pax.a pax.b)))
  (pure:m (pairs:enjs:format ~[['nodes' a+(turn srt |=([* j=json] j))]]))
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
::  +mode-arg: the ?mode= argument of the publish routes (/page-share and
::  /page-share-tree), the exact inverse of +scope-of above. Kept next to it:
::  the two directions of one vocabulary drift the moment they live apart.
::  'urbit' is an ALIAS for %shared. /page-scopes labels ames-shared pages
::  'urbit' (the search UI keys on it) and vault archives carry that label
::  verbatim, so a restore posts it straight back. Without the alias the silent
::  %private default privatizes every restored shared page.
::
::  ~ means an explicit ?mode= that isn't one of the four names below: a typo
::  or a wrong-vocabulary guess. The caller 400s on that, the same as
::  /share-file already does for its own mode param. A mistyped mode used to
::  land the page private with a plain 200, no sign anything was off.
::
++  mode-arg
  |=  args=(map @t @t)
  ^-  (unit share-mode:le)
  ?+  (~(gut by args) 'mode' 'private')  ~
    %private   `%private
    %shared    `%shared
    %urbit     `%shared
    %clearweb  `%clearweb
  ==
::  +content-reindex: rebuild the term index from the live tree + know vault.
::  Two reads total (one deep page peek, one know-map read), then one write.
::
::  The populate goes through +index-write, one bole for the whole index, so a
::  rebuild is a single dart no matter how big the vault is.
++  content-reindex
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  ;<  sn=view:nexus  bind:m  (peek:io (rv up /page) ~)
  =/  pages=(list [rel=path body=@t shr=share-mode:le])
    ?.  ?=([%ball *] sn)  ~
    (index-walk ball.sn ~)
  ;<  entries=(map path know-entry:lk)  bind:m  read-know-map
  =/  page-rows=(list [scope=@t key=@t terms=(list [term=@t tf=@ud])])
    %+  turn  pages
    |=  [rel=path body=@t shr=share-mode:le]
    :+  (scope-of shr)  (crip (pax-str rel))
    ::  the same body cap the know half applies, so one giant page cannot
    ::  dominate a rebuild
    %+  top-terms:li  term-max:li
    (index-terms:li *(map @t @ud) (trip (end [3 body-cap] body)))
  =/  know-rows=(list [scope=@t key=@t terms=(list [term=@t tf=@ud])])
    %+  turn  ~(tap by entries)
    |=  [key=path e=know-entry:lk]
    :+  'knowledge'  (spat key)
    %+  top-terms:li  term-max:li
    (index-terms:li *(map @t @ud) (trip (end [3 body-cap] body.e)))
  ::  flatten to (scope, key, term, tf) and write the WHOLE index as ONE bole.
  ::
  ::  This is the entire point of the layout. The old external index took ~200
  ::  pokes, each peeking and rewriting a whole database, and since every local
  ::  dart drains inside ONE Arvo event that was one enormous event, which is why
  ::  it wedged HTTP rather than merely being slow. A bole is a single %make dart
  ::  with a single tree hash: O(rows) once.
  =/  rows=(list [scope=@t key=@t term=@t tf=@ud])
    %-  zing
    %+  turn  (weld page-rows know-rows)
    |=  [scope=@t key=@t terms=(list [term=@t tf=@ud])]
    ^-  (list [scope=@t key=@t term=@t tf=@ud])
    %+  turn  terms
    |=  [term=@t tf=@ud]
    [scope key term tf]
  (index-write (group:li rows))
::  +index-write: replace the whole term index with one dart.
::
::  EVERY bucket is emitted, including empty ones, so a rebuild after documents
::  were deleted cannot leave a stale bucket behind holding their postings.
++  index-write
  |=  full=(map @ta bucket:li)
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  =/  contents=(map @ta [=bask:tarball gain=?])
    %-  ~(gas by *(map @ta [bask:tarball ?]))
    %+  turn  all-names:li
    |=  nm=@ta
    ^-  [@ta [bask:tarball ?]]
    [nm [[/lattice %index-bucket] (~(gut by full) nm *bucket:li)] %.n]
  =/  bol=bole:tarball  [`[~ ~ %.n contents] ~]
  ::  a bole targets a DIRECTORY, so the road is an absolute fold [%& %| path].
  ::  A rail hangs the fiber forever, because the dart never resolves and +make
  ::  waits on a made that cannot arrive.
  ::
  ::  Buckets live under /idx/b, not /idx, because +sync-bole DELETES anything in
  ::  the directory that the bole omits. Keeping them in their own covered dir
  ::  means a rebuild can never take out a sibling.
  ::  make-soft, not make: +make waits for a made that never arrives if the dart
  ::  is refused, so a bad road or a rejected bole hangs the request fiber
  ::  forever, which is exactly how this failed the first time. Soft turns that
  ::  into a tang we can see.
  ::  CULL FIRST. fiberio only exposes a forced write for single files (over /
  ::  over-as); make and make-soft always send force=%.n, so a bole aimed at a
  ::  directory that already exists silently no-ops. It reports success and
  ::  writes nothing. Removing the directory makes the bole the creating write.
  ::
  ::  Safe because /idx/b holds only derived postings and the whole point of this
  ::  arm is to replace all of them. The on-load %fall row recreates the dir if a
  ::  reload lands in the gap.
  =/  dst=road:tarball  (rv up /idx/b)
  ;<  *  bind:m  (cull-soft:io dst)
  ;<  err=(unit tang)  bind:m  (make-soft:io dst &+bol)
  ?~  err  (pure:m ~)
  ~&([%lattice-index-write-failed u.err] (pure:m ~))
::  +index-look: the postings for one term. One peek of one bucket. The bucket
::  name is computed from the term, so cost is independent of corpus size.
++  index-look
  |=  term=@t
  =/  m  (fiber:fiber:nexus ,(list [scope=@t key=@t tf=@ud]))
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  ;<  vn=view:nexus  bind:m
    (peek:io (rf up /idx/b (name-of:li term)) ~)
  ?.  ?=([%file *] vn)  (pure:m ~)
  =/  bk=bucket:li
    (fall (mole |.(!<(bucket:li (need-vase:tarball sang.vn)))) *bucket:li)
  (pure:m (look:li bk term))
::  +tree-walk: +dump-walk's twin without bodies: path+kind+size+rev+mtime+
::  share per page, folders as bare nodes. share comes from the /share grub in
::  the same ball (absent -> %private, the same rule as +read-share).
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
  =/  drow=(list [@t json])  (dname-row fils)
  ?.  (~(has by fils) %code)
    ?~  rel  kids
    :_  kids
    :-  rel
    %-  pairs:enjs:format
    %+  weld  drow
    ^-  (list [@t json])
    ~[['path' s+(crip (pax-str rel))] ['page' b+|]]
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
  %+  weld  drow
  ^-  (list [@t json])
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
::  O(pages) local peeks. Warms a filesystem client's whole read-cache so
::  rg/grep never touch the network again.
::  +dump-inline-max: bodies larger than this (256 KB) are NOT inlined in
::  page-dump. The client fetches them on demand via page-source. Keeps one
::  warm dump bounded per file, so a few big pages can't balloon the payload
::  or the client's RAM cache. The node still carries an accurate `size`.
++  dump-inline-max  ^~((mul 256 1.024))
++  fs-dump-json
  =/  m  (fiber:fiber:nexus ,json)
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  ::  the current /beacon/rev rides along. The dump is a SNAPSHOT, and the
  ::  client's beacon stream only reports changes from its registration
  ::  onward — a bump between this snapshot and that registration was
  ::  invisible on a first-ever session (nothing remembered to compare the
  ::  registration's rev against). With the snapshot's rev in hand, the
  ::  client always has a baseline, and the gap closes by comparison for
  ::  fresh profiles exactly as it does for returning ones.
  ;<  bv=view:nexus  bind:m
    (peek:io (rf up /beacon %rev) ~)
  =/  rev=json
    ?.  ?=([%file *] bv)  ~
    (fall (mole |.(;;(json (sang-noun:tarball sang.bv)))) ~)
  ;<  sn=view:nexus  bind:m  (peek:io (rv up /page) ~)
  ?.  ?=([%ball *] sn)
    (pure:m (pairs:enjs:format ~[['nodes' a+~] ['rev' rev]]))
  =/  nodes=(list [pax=path j=json])  (dump-walk ball.sn wave.sn ~)
  =/  srt  (sort nodes |=([a=[pax=path *] b=[pax=path *]] (aor pax.a pax.b)))
  =/  js=(list json)  (turn srt |=([* j=json] j))
  (pure:m (pairs:enjs:format ~[['nodes' a+js] ['rev' rev]]))
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
  =/  drow=(list [@t json])  (dname-row fils)
  ?.  (~(has by fils) %code)
    ?~  rel  kids
    :_  kids
    :-  rel
    %-  pairs:enjs:format
    %+  weld  drow
    ^-  (list [@t json])
    ~[['path' s+(crip (pax-str rel))] ['page' b+|]]
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
  (pairs:enjs:format :(weld drow head body-row tail))
::  +dname-row: the `dname` field of a tree node, from the %name grub in the
::  same ball as its %code (or, for a folder, its flags). Absent -> no field:
::  the client shows the path segment, and a valid name is never stored twice.
::  mole/;;-fenced like %share: a broken grub reads as no display name.
++  dname-row
  |=  fils=(map @ta [=sang:tarball gain=? bang=(unit tang)])
  ^-  (list [@t json])
  =/  nd  (~(get by fils) %name)
  ?~  nd  ~
  =/  j=(unit json)  (mole |.(;;(json (sang-noun:tarball sang.u.nd))))
  ?~  j  ~
  ?.  ?=([%s *] u.j)  ~
  ~[['dname' s+p.u.j]]
::  +read-dname: a page's or folder's display name, by peek. Used where the
::  ball is not already in hand (moves).
++  read-dname
  |=  dir=path
  =/  m  (fiber:fiber:nexus ,(unit @t))
  ^-  form:m
  ;<  nn=view:nexus  bind:m  (peek:io [%& %& dir %name] ~)
  %-  pure:m
  ?.  ?=([%file *] nn)  ~
  =/  j=(unit json)  (mole |.(;;(json (sang-noun:tarball sang.nn))))
  ?~  j  ~
  ?.  ?=([%s *] u.j)  ~
  `p.u.j
::  +dname-acts: the %dname actions that carry the display names of `dirs`
::  (relative to sdir) to the same rels under `to`. One peek per dir; moves
::  are rare.
++  dname-acts
  |=  [sdir=path to=path dirs=(list path)]
  =/  m  (fiber:fiber:nexus ,(list eval-action:le))
  ^-  form:m
  ?~  dirs  (pure:m ~)
  ;<  dn=(unit @t)  bind:m  (read-dname (weld sdir i.dirs))
  ;<  rest=(list eval-action:le)  bind:m  $(dirs t.dirs)
  %-  pure:m
  ?~  dn  rest
  [[%dname (weld to i.dirs) u.dn] rest]
::  +split-fas: a cord on '/', keeping empty pieces ("/My Page" -> ['' 'My Page']).
::  Byte-wise, so a typed name in any script survives.
++  split-fas
  |=  t=@t
  ^-  (list @t)
  =/  tap=tape  (trip t)
  =|  cur=tape
  =|  acc=(list @t)
  |-  ^-  (list @t)
  ?~  tap  (flop [(crip (flop cur)) acc])
  ?:  =('/' i.tap)  $(tap t.tap, acc [(crip (flop cur)) acc], cur ~)
  $(tap t.tap, cur [i.tap cur])
::  +dname-acts-of: the display-name writes a request asks for at `pax`.
::  ?dname=<text> names the leaf ('' clears it). ?dnames=<a/b/c> names every
::  segment of pax at its depth, '' for a segment that needs none; only
::  non-empty entries write, so a folder that already had a name keeps it
::  when something is made inside it under the plain slug. Entries past
::  the path's length are ignored.
++  dname-acts-of
  |=  [args=(map @t @t) pax=path]
  ^-  (list eval-action:le)
  =/  leaf=(list eval-action:le)
    =/  dn=(unit @t)  (~(get by args) 'dname')
    ?~  dn  ~
    [%dname pax u.dn]~
  =/  ds=(unit @t)  (~(get by args) 'dnames')
  ?~  ds  leaf
  =/  segs=(list @t)  (split-fas u.ds)
  =/  i=@ud  1
  |-  ^-  (list eval-action:le)
  ?~  segs  leaf
  ?:  (gth i (lent pax))  leaf
  =/  rest  $(segs t.segs, i +(i))
  ?:  =('' i.segs)  rest
  [[%dname (scag i pax) i.segs] rest]
::  +poke-dnames: apply +dname-acts-of, one writer poke each, in order.
++  poke-dnames
  |=  [args=(map @t @t) pax=path]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  =/  acts=(list eval-action:le)  (dname-acts-of args pax)
  |-  ^-  form:m
  ?~  acts  (pure:m ~)
  ;<  ~  bind:m  (poke-eval i.acts)
  $(acts t.acts)
::  +fs-source-result: a page's source as (each json [code msg]): the json on
::  %&, an HTTP-style [code msg] error on %|.
++  fs-source-result
  |=  [name=@t render=?]
  =/  m  (fiber:fiber:nexus ,(each json [code=@ud msg=@t]))
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  ?.  (valid-name name)  (pure:m [%| 400 'bad name'])
  =/  pax=path  (pax-of name)
  =/  pdir=path  (weld /page pax)
  ;<  cn=view:nexus  bind:m  (peek:io (rf up pdir %code) ~)
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
    ::  the cast homogenizes the row literal. weld is wet, and a bare :~ of
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
  ;<  up=@ud  bind:m  nexus-up
  ?.  (valid-name name)  (pure:m '')
  =/  pdir=path  (weld /page (pax-of name))
  ;<  en=view:nexus  bind:m  (peek:io (rf up pdir %err) ~)
  ?.  ?=([%file *] en)  (pure:m '')
  (pure:m (fall (mole |.(;;(@t (sang-noun:tarball sang.en)))) ''))
::  +fs-poke-eval: poke the writer (main.sig) with an eval-action. Called from the
::  /fs.sig fiber, which sits at the app root as a sibling of main.sig, so the
::  road is a fixed up-0 (unlike +poke-eval's up-2 from /ui/requests).
++  fs-poke-eval
  |=  act=eval-action:le
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  (poke:io [%| 0 %& ~ %'main.sig'] [[/lattice %eval-action] act])
::  +fs-save: create/overwrite a page (POST /page-save + lick %page-save). The
::  name and body rules are +save-src, the same front half the HTTP route runs.
::  ?new rejects an existing page with 409. The route's ?base= conflict protocol
::  is HTTP-only: this surface answers [status body] and has nowhere to report a
::  conflicted write or name the body it kept.
++  fs-save
  |=  [name=@t ptype=@tas new=? raw=@t]
  =/  m  (fiber:fiber:nexus ,[status=@ud rbody=@t])
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  =/  sr  (save-src name ptype raw)
  ?:  ?=(%| -.sr)  (pure:m [code.p.sr msg.p.sr])
  =/  src=@t  p.sr
  ;<  ex=?  bind:m
    (peek-exists:io (rf up (weld /page (pax-of name)) %code))
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
::  +fs-op: the shared request dispatcher. `path`'s last segment selects the op.
::  `query` is "k=v&k=v" (raw, page names are @ta so need no url-decode). Returns
::  [status body], for the lick port to spit, and for the HTTP routes to send.
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
::  based on absence must use this one.
++  read-know-vault-safe
  =/  m  (fiber:fiber:nexus ,(unit (map path know-entry:lk)))
  ^-  form:m
  ;<  seen=view:nexus  bind:m  (peek:io [%| 2 %| /know/vault] ~)
  ?.  ?=([%ball *] seen)  (pure:m ~)
  (pure:m `(collect-entries ~ ball.seen))
::  +serve-ui: stream a ui-app asset grub. MIME from the (whitelisted) name;
::  anything unknown 404s. Assets are grubs so the request-fiber core stays
::  small. Never serve big blobs from core constants.
::
++  serve-ui
  |=  [eyre-id=@ta rest=path]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  =/  nam=@ta  ?~(rest %'index.html' i.rest)
  =/  ct=(unit @t)
    ?:  =(%'index.html' nam)  `'text/html'
    ?:  =(%'app.js' nam)      `'text/javascript'
    ?:  =(%'vault.js' nam)    `'text/javascript'
    ~
  ?~  ct  (send-err eyre-id 404 'not found')
  ;<  pv=view:nexus  bind:m  (peek:io (rf up /app nam) ~)
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
      ;<  rv=tape  bind:m  beacon-rev-tape
      (send-view-long eyre-id (render-page-titled "know" (keep-url "beacon/rev") rv "memories" (know-flat-html:lkv es u.tsel)))
    ;<  rv=tape  bind:m  beacon-rev-tape
    (send-view-long eyre-id (render-page-titled "know" (keep-url "beacon/rev") rv "memories" (know-dir-html:lkv es ~ ~ (tag-chips:lkv es ''))))
  =/  page=(unit tape)  (know-node-html:lkv es `path`rest)
  ?~  page
    (send-view eyre-id (render-page-titled "know" "" "" "memories" "<p class=\"err\">no such entry</p>"))
  ;<  rv=tape  bind:m  beacon-rev-tape
  (send-view-long eyre-id (render-page-titled (weld "know" (spud rest)) (keep-url "beacon/rev") rv (trip (rear rest)) u.page))
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
::  +manifest-gmi: the discovery-manifest body, a generated gemtext index of a
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
::  never resolves), hanging /fetch and the /x explorer's remote reads.
::
++  remote-timeout  ^-(@dr ~s30)
::  +remote-road: rewrite an absolute road into its /sys/ames mirror on `shp`, so
::  a %peek dart routes to that ship. Mirrors peek-remote's own rewrite (kept
::  local so peek-remote-wait doesn't fork fiberio just to add a deadline).
::
::  ── nexus-relative addressing ───────────────────────────────────────
::
::  A road is [%| steps lane]: climb `steps` to the nexus root, then descend.
::  `steps` is the depth of the fiber that BUILDS the road, which is why an
::  absolute road was easier and why it stopped working - a desk-installed
::  app may not learn where it sits (+walk-here stops at its boundary), and
::  +get-here-abs asserts otherwise and crashes the fiber.
::
::  +nexus-up: this fiber's distance from the nexus root, CORRECT IN BOTH
::  TIERS. lattice has to run in /apps on ricsul today and in a desk after
::  the migration, so a constant that is right for one is wrong for the
::  other.
::
::    +get-here is not +get-here-abs: it never asserts. +walk-here reveals
::    the ancestors this grub may peek and stops, so a SANDBOXED fiber gets
::    a pant that is already relative to its nexus and root=%.n. A TRUSTED
::    fiber walks all the way up, so its pant is absolute and the app base
::    has to come off. The flag says which world we are in.
::
++  nexus-up
  =/  m  (fiber:fiber:nexus ,@ud)
  ^-  form:m
  ;<  h=here:nexus  bind:m  get-here:io
  =/  n=@ud  (lent pant.h)
  ::  trusted: the walk reached root, so strip the app dir we sit under.
  ::  sandboxed: the walk stopped at our own root, so n already is it.
  (pure:m ?.(root.h n ?:((lth n (lent app-base:lu)) 0 (sub n (lent app-base:lu)))))
::  +rf, +rv: a file road and a directory road, `up` steps from here.
::
::  +writer-rail: the writer's own rail, nexus-relative - declared by the
::  /main.sig row in +on-load. The usergroup registry wants a RAIL, and a
::  sandboxed app has no absolute one to hand it.
++  writer-rail  ^-(rail:tarball [/ %'main.sig'])
++  rf  |=([up=@ud p=path n=@ta] ^-(road:tarball [%| up [%& p n]]))
++  rv  |=([up=@ud p=path] ^-(road:tarball [%| up [%| p]]))
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
::  timeout or veto. `seen otherwise. This is peek-remote (nonce + %peek dart +
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
::  +peek-remote-shallow-wait: peek-remote-wait but deep=%.n, one directory level
::  (files here + subdir names, no recursion). Used by the cross-ship browser: a
::  deep (%.y) peek of a foreign DIR would materialize its whole subtree, so a huge
::  or hostile tree could balloon memory before any render cap. Shallow bounds the
::  pull to one level per request. (A file peek is unaffected, one node either way.)
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
::  ── sharing groups (the permission editor's backend) ────────────────────
::  A grubbery usergroup is a directory /sys/ames/usergroups/<name>.grp/ with
::  two grubs: who.ships (set @p, blot [/ %ships]) and how.weir (weir:nexus,
::  blot [/ %weir]). Grubbery recomputes effective weirs on any change, so
::  writing the grubs IS the whole API, the same primitive its own MCP tools
::  use. The editor speaks read=peek / edit=make. poke is deliberately never
::  exposed. A poke grant on main.sig is full eval power, not "edit a file".
::
++  ug-base  `path`/sys/ames/usergroups
::  +ug-dirfold-paths: the roads a UI can render (absolute dir folds), plus a
::  count of the ones it can't. The count matters. The editor must SAY it is
::  preserving rules it doesn't show, or a user auditing their ACL is misled.
++  ug-dirfold-paths
  |=  rs=(set road:tarball)
  ^-  [ps=(list @t) opaque=@ud]
  %+  roll  ~(tap in rs)
  |=  [r=road:tarball acc=[ps=(list @t) opaque=@ud]]
  ?:  ?=([%& %| *] r)  [[(spat p.p.r) ps.acc] opaque.acc]
  [ps.acc +(opaque.acc)]
::  +ug-keep: the roads the UI does NOT manage, carried through a save
::  verbatim. Silently dropping an ACL rule the editor couldn't render would
::  be this feature's worst possible bug.
++  ug-keep
  |=  rs=(set road:tarball)
  ^-  (set road:tarball)
  %-  ~(gas in *(set road:tarball))
  (skip ~(tap in rs) |=(r=road:tarball ?=([%& %| *] r)))
::  +ug-read-weir: a group's stored weir, bunt if absent/undecodable.
++  ug-read-weir
  |=  gdir=path
  =/  m  (fiber:fiber:nexus ,weir:nexus)
  ^-  form:m
  ;<  hv=view:nexus  bind:m  (peek:io [%& %& gdir %'how.weir'] ~)
  ?.  ?=([%file *] hv)  (pure:m *weir:nexus)
  (pure:m (fall (mole |.(;;(weir:nexus (sang-noun:tarball sang.hv)))) *weir:nexus))
::  +share-groups-json: every usergroup, decoded for the editor.
++  share-groups-json
  =/  m  (fiber:fiber:nexus ,json)
  ^-  form:m
  ;<  dn=view:nexus  bind:m  (peek-shallow:io [%& %| ug-base] ~)
  ?.  ?=([%ball *] dn)  (pure:m a+~)
  =/  names=(list @ta)  (sort ~(tap in ~(key by dir.ball.dn)) aor)
  =|  out=(list json)
  |-  ^-  form:m
  ?~  names  (pure:m a+(flop out))
  =/  nt=tape  (trip i.names)
  ?.  &((gth (lent nt) 4) =(".grp" (slag (sub (lent nt) 4) nt)))
    $(names t.names)
  =/  base=@t  (crip (scag (sub (lent nt) 4) nt))
  =/  gdir=path  (snoc ug-base i.names)
  ;<  wv=view:nexus  bind:m  (peek:io [%& %& gdir %'who.ships'] ~)
  =/  ships=(list @p)
    ?.  ?=([%file *] wv)  ~
    %+  fall
      (mole |.((sort ~(tap in ;;((set @p) (sang-noun:tarball sang.wv))) lth)))
    ~
  ;<  w=weir:nexus  bind:m  (ug-read-weir gdir)
  =/  pk  (ug-dirfold-paths peek.w)
  =/  mk  (ug-dirfold-paths make.w)
  =/  po  (ug-dirfold-paths poke.w)
  =/  gj=json
    %-  pairs:enjs:format
    :~  ['name' s+base]
        ['ships' a+(turn ships |=(s=@p s+(scot %p s)))]
        ['peek' a+(turn ps.pk |=(t=@t s+t))]
        ['make' a+(turn ps.mk |=(t=@t s+t))]
        ['poke' a+(turn ps.po |=(t=@t s+t))]
        ['opaque' (numb:enjs:format :(add opaque.pk opaque.mk opaque.po))]
    ==
  $(names t.names, out [gj out])
::  +apply-share-notice: one inbox poke. Everything about it is defensive:
::  the payload is soft-cast (any ship can send anything), the path must be
::  under /apps, the mode must be one of ours, and %del from a foreign ship is
::  dropped. The transport decides who the sender is, never the payload.
::
++  apply-share-notice
  |=  [root=@ud =from:fiber:nexus =sage:tarball now=@da]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  =/  src=(unit @p)  (get-poke-src:io from)
  ::  a poke's sage is [blot VASE] (unlike a peek's sang, whose q is an each).
  ::  The payload noun is q.q.sage. Gate on the blot first so a stray poke of
  ::  some other mark is ignored rather than misparsed.
  ?.  =([/lattice %share-notice] p.sage)  (pure:m ~)
  =/  na=(unit action:ls)  (mole |.(;;(action:ls q.q.sage)))
  ?~  na  (pure:m ~)
  ;<  sn=view:nexus  bind:m  (peek:io (rf root / %shared) ~)
  =/  cur=shared:ls
    ?.  ?=([%file *] sn)  ~
    (fall (mole |.(;;(shared:ls (sang-noun:tarball sang.sn)))) ~)
  ;<  bans=banned:ls  bind:m  read-banned
  ?-    -.u.na
      %add
    ?~  src  (pure:m ~)                      ::  own %add is meaningless
    ::  the inbox is the one surface /public opens to EVERY ship, so it is the
    ::  surface a banlist exists for. Drop silently. Telling a banned sender
    ::  their notice was refused just confirms the address is live.
    ?:  (is-banned:ls bans u.src)  (pure:m ~)
    ?.  ?=([%apps *] pax.u.na)  (pure:m ~)
    ?.  |(=('read' mode.u.na) =('edit' mode.u.na))  (pure:m ~)
    %^  put-file  (rf root / %shared)  [/lattice %shared]
    (put-entry:ls cur [u.src pax.u.na mode.u.na now])
  ::
      %del
    ?^  src  (pure:m ~)                      ::  curation is owner-only
    %^  put-file  (rf root / %shared)  [/lattice %shared]
    (del-entry:ls cur host.u.na pax.u.na)
  ==
::  +strip-ship-from-groups: remove one ship from every usergroup's who.ships,
::  returning how many groups changed. This is what makes a ban a revocation
::  rather than a note. Grants are unioned across the groups a ship belongs to,
::  so membership IS access, and leaving it in place would leave it reachable.
::  The grant ROADS are untouched. They belong to the group, not the ship, and
::  other members still need them.
::  +apply-comment-notice: a comment poked by ANOTHER ship.
::
::  Everything that decides whether it lands is read here, never from the
::  payload: the author is the transport source, the banlist is ours, and
::  +apply-comment re-checks that the page exists and has comments enabled and
::  caps the body. A payload can only ever say WHICH page and WHAT text.
::
::  Refusals are silent. Telling a banned or unwanted sender why just confirms
::  the address is live, the same reasoning the shares inbox uses.
::
++  apply-comment-notice
  |=  [root=@ud =from:fiber:nexus =sage:tarball now=@da]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  =/  src=(unit @p)  (get-poke-src:io from)
  ::  no source means a local poke, which belongs to the owner route
  ?~  src  (pure:m ~)
  ::  gate on the blot before parsing, so a stray poke of another mark is
  ::  ignored rather than misread
  ?.  =([/lattice %comment-action] p.sage)  (pure:m ~)
  =/  na=(unit comment-action:lc)  (mole |.(;;(comment-action:lc q.q.sage)))
  ?~  na  (pure:m ~)
  ;<  bans=banned:ls  bind:m  read-banned
  ?:  (is-banned:ls bans u.src)  (pure:m ~)
  (apply-comment root u.src now u.na)
++  strip-ship-from-groups
  |=  who=@p
  =/  m  (fiber:fiber:nexus ,@ud)
  ^-  form:m
  ;<  dn=view:nexus  bind:m  (peek-shallow:io [%& %| ug-base] ~)
  ?.  ?=([%ball *] dn)  (pure:m 0)
  =/  names=(list @ta)  (sort ~(tap in ~(key by dir.ball.dn)) aor)
  =|  hit=@ud
  |-  ^-  form:m
  ?~  names  (pure:m hit)
  =/  nt=tape  (trip i.names)
  ?.  &((gth (lent nt) 4) =(".grp" (slag (sub (lent nt) 4) nt)))
    $(names t.names)
  =/  gdir=path  (snoc ug-base i.names)
  ;<  wv=view:nexus  bind:m  (peek:io [%& %& gdir %'who.ships'] ~)
  =/  ships=(set @p)
    ?.  ?=([%file *] wv)  ~
    (fall (mole |.(;;((set @p) (sang-noun:tarball sang.wv)))) ~)
  ?.  (~(has in ships) who)
    $(names t.names)
  ;<  ~  bind:m
    (over:io [%& %& gdir %'who.ships'] [[/ %ships] (~(del in ships) who)])
  $(names t.names, hit +(hit))
::  +ban-road: where the banlist lives.
++  ban-road  |=(up=@ud ^-(road:tarball (rf up / %banned)))
::  +read-banned: the banlist, empty if never written. Every enforcement point
::  reads it fresh. A ban has to take effect on the next poke, not on the next
::  restart.
++  read-banned
  =/  m  (fiber:fiber:nexus ,banned:ls)
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  ;<  bv=view:nexus  bind:m  (peek:io (ban-road up) ~)
  ?.  ?=([%file *] bv)  (pure:m ~)
  (pure:m (fall (mole |.(;;(banned:ls (sang-noun:tarball sang.bv)))) ~))
::  +ug-merge: fold ships and grants INTO a usergroup, creating it if absent.
::  The per-file share flow uses this (one auto-group per ship, named after
::  it) so repeated shares accumulate instead of replacing.
::
++  ug-merge
  |=  [gname=@t ships=(set @p) pk=(set road:tarball) mk=(set road:tarball)]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  =/  gdir=path  (snoc ug-base (crip (weld (trip gname) ".grp")))
  ;<  wv=view:nexus  bind:m  (peek:io [%& %& gdir %'who.ships'] ~)
  =/  cur=(set @p)
    ?.  ?=([%file *] wv)  ~
    (fall (mole |.(;;((set @p) (sang-noun:tarball sang.wv)))) ~)
  ;<  old=weir:nexus  bind:m  (ug-read-weir gdir)
  =/  =weir:nexus
    :+  (~(uni in make.old) mk)
      poke.old
    (~(uni in peek.old) pk)
  ;<  ~  bind:m  (over:io [%& %& gdir %'who.ships'] [[/ %ships] (~(uni in cur) ships)])
  ;<  ~  bind:m  (over:io [%& %& gdir %'how.weir'] [[/ %weir] weir])
  (pure:m ~)
::  +remote-load-poke-wait: +remote-load-poke with a deadline. %.y = acked in
::  time. An offline ship never acks a gall poke, and a share notice must not
::  hang the save that triggered it. The GRANT is already durable by the time
::  this runs. The notice is best-effort and says so in the response.
::
++  remote-load-poke-wait
  |=  [target=@p req=load:remo:nexus timeout=@dr]
  =/  m  (fiber:fiber:nexus ,?)
  ^-  form:m
  ;<  now=@da  bind:m  bowl-now
  =/  until=@da  (add now timeout)
  ;<  ~  bind:m
    %+  poke:io  &+&+[/sys/gall %'main.sig']
    [[/ %gall-poke] [[target %grubbery] grubbery-load+req]]
  ;<  ~  bind:m  (send-wait:io until)
  |=  input:fiber:nexus
  :+  ~  q.state
  ?+  in  [%skip ~]
      ~  [%wait ~]
      [~ %veto *]
    [%done %.n]
      [~ %pack *]
    [%done ?=(~ err.u.in)]
      [~ %poke * *]
    ?.  =([/ %timer-wake] p.sage.u.in)  [%skip ~]
    =/  wak=path  !<(path q.sage.u.in)
    ?.  ?&(?=([%wait @ ~] wak) =(until (slav %da i.t.wak)))  [%skip ~]
    [%done %.n]
  ==
::  +remote-load-poke: send a %grubbery-load to another ship and wait for the
::  gall ack. Modeled on +gall-poke-or-nack (fiberio), which is our-ship-only;
::  a bare +gall-poke:io would CRASH the request fiber on a remote nack, taking
::  the HTTP response with it. ~ = acked; `tang = nacked (their side crashed or
::  refused). NOTE an ack is not proof the write LANDED (a weir denial on
::  their side is applied after the ack, silently), so /remote-save verifies
::  by revision number afterwards.
::
++  remote-load-poke
  |=  [target=@p req=load:remo:nexus]
  =/  m  (fiber:fiber:nexus ,(unit tang))
  ^-  form:m
  ;<  ~  bind:m
    %+  poke:io  &+&+[/sys/gall %'main.sig']
    [[/ %gall-poke] [[target %grubbery] grubbery-load+req]]
  |=  input:fiber:nexus
  :+  ~  q.state
  ?+  in  [%skip ~]
      ~  [%wait ~]
      [~ %veto *]
    [%done `~[leaf+"vetoed locally"]]
      [~ %pack *]
    [%done err.u.in]
  ==
::  +take-peek-or-wake: resolve on the matching %peek response OR our timer wake.
::  Sibling of take-news-or-wake. A %veto counts as give-up (~), like a timeout.
::
++  take-peek-or-wake
  |=  [pwire=wire until=@da]
  =/  m  (fiber:fiber:nexus ,(unit view:nexus))
  ^-  form:m
  |=  input:fiber:nexus
  :+  ~  q.state
  ?+  in  [%skip ~]
      ~  [%wait ~]
      ::  a veto gives up (~) like a timeout, but ONLY for OUR peek's dart. Gate on
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
::  but the take MARK-FILTERS the bowl reply. A stray poke (a queued %know-action,
::  %eval-action, etc. buffered while this fiber was mid-work) is %skip'd back to the
::  owning loop instead of being stolen. fiberio's get-our/get-time use a plain
::  take-poke, so in a busy fiber (the writer, a keep fiber) they grab a
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
::  +take-news-or-wake-until: like fiberio's take-news-or-wake, but the timer-wake
::  branch matches ONLY our own `until` timer (mirrors take-peek-or-wake). fiberio's
::  version matches ANY %timer-wake, so a stale timer left armed by an earlier
::  read in the SAME long-lived fiber (a keep fiber runs many in sequence)
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
::  %peek/%veto and the late %keen-response poke a timed-out keen leaves behind.
::  fiberio has no dart-cancel, so an abandoned read's answer still arrives (a
::  keen's arrives as a %keen-response poke-back, correlated by wire). fiberio's
::  take-wake %skips those strays (piling them in the skip queue forever) and
::  CRASHES on a stray %veto. Here all are consumed. Used by +sleep-draining,
::  which re-checks the clock after each drain.
++  take-wake-drain
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  |=  input:fiber:nexus
  :+  ~  q.state
  ?+  in  [%skip ~]
      ~  [%wait ~]
      [~ %poke * *]
    ::  poke-acks are consumed, never skipped. Every gall-poke-fire
    ::  gets one back, a skipped input re-offers on EVERY later take,
    ::  and a long-lived fiber that fires thousands of pokes (the
    ::  reconciler's statement stream) turns its own skip pile into a
    ::  per-tick rescan that made its round-trips two hundred times
    ::  slower than a fresh fiber's. Nothing ever awaits these acks.
    ?:  ?|  =([/ %timer-wake] p.sage.u.in)
            =([/ %keen-response] p.sage.u.in)
            =([/ %poke-ack] p.sage.u.in)
        ==
      [%done ~]
    [%skip ~]
      [~ %peek * *]  [%done ~]
      [~ %veto *]    [%done ~]
  ==
::  +take-news-or-wake-drain: take-news-or-wake that ALSO drains a stray remote
::  %peek/%veto and the late %keen-response poke (as a %wake), so a keep loop
::  clears the late reads its timed-out peeks and keens leave behind instead of
::  piling them forever. A real %news on news-wire still re-indexes. Anything
::  else is skipped.
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
    ?.  ?|(=([/ %timer-wake] p.sage.u.in) =([/ %keen-response] p.sage.u.in))
      [%skip ~]
    [%done %wake ~]
      [~ %peek * *]  [%done %wake ~]
      ::  drain a STALE peek's veto (a stray from a timed-out remote peek), but NOT a
      ::  veto of THIS loop's own keep (news-wire). That means the subscription died,
      ::  and swallowing it as a keepalive would hide the failure. Gate on the dart
      ::  wire like take-peek-or-wake; both are %node darts, told apart by wire.
      [~ %veto %node * * *]
    ?:  =(news-wire wire.dart.u.in)  [%skip ~]
    [%done %wake ~]
  ==
::  +sub-wave: what one turn of the /sub/pages loop saw. Either the page
::  grub's own wave (carrying the dir's cass axal, out of which the loop
::  reads the new rev) or a drained stray.
::
+$  sub-wave
  $%  [%wake ~]
      [%page =wave:nexus]
  ==
::  +take-sub-wave-drain: +take-news-or-wake-drain widened for the /sub/pages
::  loop's keep. %news on /page resolves as itself, and the drain also
::  consumes the late %keen-response poke a timed-out +keen-page leaves behind.
::  The keen answer arrives as a %keen-response poke-back (see +take-keen-sage
::  in grubbery), and this is a long-lived fiber, so anything merely %skipped
::  piles in its skip queue forever. Safe to drain unconditionally, since a
::  keen-response can only answer this fiber's own earlier keen, and no keen is
::  in flight while the loop sits here. A %veto of this loop's own keep is
::  still %skipped, not swallowed. That subscription died, and reading it as a
::  keepalive would hide the failure.
::
++  take-sub-wave-drain
  =/  m  (fiber:fiber:nexus ,sub-wave)
  ^-  form:m
  |=  input:fiber:nexus
  :+  ~  q.state
  ?+  in  [%skip ~]
      ~  [%wait ~]
      [~ %news * *]
    ?:  =(/page wire.u.in)  [%done %page wave.u.in]
    [%skip ~]
      [~ %poke * *]
    ?:  ?|(=([/ %timer-wake] p.sage.u.in) =([/ %keen-response] p.sage.u.in))
      [%done %wake ~]
    [%skip ~]
      [~ %peek * *]  [%done %wake ~]
      [~ %veto %node * * *]
    ?:  =(/page wire.dart.u.in)  [%skip ~]
    [%done %wake ~]
  ==
::  +page-rel: normalize a fetch/subscribe spur to the vault-relative page path.
::  The home spur (empty) is the authored /index page (so urb://~ship/ resolves).
::  A /pub/<spur>/gmi content-map key (round-tripped from a search result) is
::  stripped back to /<spur>. A plain vault spur is untouched (idempotent). Shared
::  by read-page-body and the /sub keep fiber so the keep road and the read both
::  derive from the SAME normalized spur.
::
++  page-rel
  |=  rel=path
  ^-  path
  ?:  ?=(~ rel)  /index
  ?.  ?&(=(%pub i.rel) =(%gmi (rear rel)))  rel
  (snip (strip-pub:lp rel))
::  +read-page-body: the gemtext of a published page, shared by /fetch and the
::  web reader. Own pages peek the local pub vault. Remote pages use the bounded
::  peek-remote-wait (~ if absent, unreachable, or slow past remote-timeout).
::
::  DELIBERATELY NOT scry-first (mesa D1 phase C). /fetch, the web reader and
::  the /x/ explorer all read through here or through peek-remote-wait
::  directly, and none of them can name a %keen spur:
::
::    * a request fiber is born and dies per request, so it never carries a
::      remembered rev, and nothing durable holds one. The peer's manifest rows
::      are [updated bytes hash], no rev column anywhere. Giving /fetch a rev
::      would mean INVENTING new persistence (a rev grub + mark + on-load row)
::      for a read that already costs exactly one peek. Not done.
::    * the /sub/pages reader needs no remembered rev at all. The %news wave
::      that says the peer JUST edited this page carries the fresh cass, and
::      +sub-apply-wave keens at exactly that rev.
::    * the /x/ explorer reads arbitrary tree nodes, which the mirror does not
::      publish. Only /pub/page/<rel>/<rev> and /pub/index/<seq> exist in the
::      namespace.
::
::  The seam is one call away if a later phase gives readers a rev: remember it
::  alongside the body and %keen the spur it names. Writes (comments,
::  /remote-save, share notices) stay on the weir-gated poke path by design and
::  are not candidates at all.
::
++  read-page-body
  |=  [our=@p shp=@p rel=path]
  =/  m  (fiber:fiber:nexus ,(unit @t))
  ^-  form:m
  ;<  pr=(unit [rev=@ud body=@t])  bind:m  (read-page-body-rev our shp rel)
  (pure:m ?~(pr ~ `body.u.pr))
::  +read-page-body-rev: +read-page-body, but it also hands back the REVISION
::  the body came from. The peek view already carries the grub's cass ([%file
::  =cass =sang], and a cross-ship discharge fills it from the remote's own
::  snap), so the read that fetches a body teaches us its revision for free.
::  That is the only rev source a reader has (docs D1), and it is why the mesa
::  read path never costs an extra round trip to learn one.
::
++  read-page-body-rev
  |=  [our=@p shp=@p rel=path]
  =/  m  (fiber:fiber:nexus ,(unit [rev=@ud body=@t]))
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  ::  `our` is a parameter, not a bowl-our bind. Callers already hold it (the
  ::  owner gate's src, or their own binding), and the /sys/bowl round trip
  ::  cost ~0.2s on every reader view for a value that never changes.
  ::  tolerate a /pub/<spur>/gmi url form: that is the content-map key a search
  ::  result or a peer manifest row carries, so a client round-tripping one into
  ::  /fetch or the reader passes rel=/pub/<spur>/gmi. Strip the leading pub +
  ::  trailing gmi back to the vault-relative /<spur> /fetch expects. A plain vault
  ::  rel (no leading pub / no trailing gmi) is untouched. ponytail: a page literally
  ::  published as "pub/…/gmi" would be mis-normalized (accepted, that key is absurd).
  =/  rel=path  (page-rel rel)
  ::  own pages: ABSOLUTE road via app-base (the nexus's fixed tree path), so this
  ::  resolves the same at every fiber depth.
  =/  road=road:tarball
    (rf up (weld /pub/vault rel) %gmi)
  ?:  =(shp our)
    ;<  seen=view:nexus  bind:m  (peek:io road ~)
    ?.  ?=([%file *] seen)  (pure:m ~)
    (pure:m `[ud.cass.seen !<(@t (need-vase:tarball sang.seen))])
  ;<  ms=(unit view:nexus)  bind:m  (peek-remote-wait road shp)
  ?~  ms  (pure:m ~)
  ?.  ?=([%file *] u.ms)  (pure:m ~)
  ::  CROSS-SHIP peek content is a boom (raw noun), NOT a vase. need-vase would
  ::  crash. Extract via sang-noun and clam in a mule so a malformed/hostile peer
  ::  body yields ~ (clean 404) instead of a crash.
  =/  res=(each @t tang)  (mule |.(;;(@t (sang-noun:tarball sang.u.ms))))
  ?:  ?=(%| -.res)  (pure:m ~)
  (pure:m `[ud.cass.u.ms p.res])
::  +explore: GET /x/<ship>/<path...>, the server-rendered tree explorer
::  (docs/platform.md, build step 1). Directories render as listings with
::  relative child links; trailing slash is forced on directory urls (hawk
::  convention: relative hrefs resolve against the listing). Files render
::  mark-aware. ?data serves the raw body with a mark-derived content-type.
::  Own tree peeks locally. A foreign ship's gained tree via remote peek.
::  Owner-only like every route (clearweb projection is build step 4).
::  No trailing slash -> try file first (the common case for leaf urls), then
::  dir + redirect; trailing slash -> dir first. Remote: an unreachable ship is
::  504 on the FIRST wait (a ~ result means no answer, not wrong-kind), so the
::  fallback attempt only runs when the ship answered with the wrong node kind.
::
++  explore
  ::  `our` is threaded from handle-request. bowl-our is a full /sys/bowl round
  ::  trip (~0.2s) and the caller already paid it, so re-fetching it here doubled
  ::  the cost of every explorer/page request.
  |=  [eyre-id=@ta our=@p rest=path args=(map @t @t) raw-url=@t]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ::  a trailing '/' parses as a trailing EMPTY knot (smeg matches ''), which
  ::  would send every slashed dir url down the peek path as a child literally
  ::  named '' -> 404 (caught by review). Trim trailing empties up front.
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
  ::  the canonical urb:// address for this node, shown in the chrome bar so any
  ::  view is copy-shareable (the browser url stays the /x projection).
  =/  canon=tape  (trip (en-urb:lu u.shp pax))
  =/  dir-road=road:tarball  [%& %| pax]
  ?~  pax
    ::  ship root: always a directory
    ?.  slashed  (send-redirect eyre-id (weld base "/"))
    ?:  =(u.shp our)
      ;<  dn=view:nexus  bind:m  (peek-shallow:io dir-road ~)
      ?.  ?=([%ball *] dn)  (send-err eyre-id 404 'not found')
      (send-view eyre-id (render-page-titled canon "" "" (scow %p u.shp) (explore-dir-html u.shp pax ball.dn)))
    ;<  md=(unit view:nexus)  bind:m  (peek-remote-shallow-wait dir-road u.shp)
    ?~  md  (send-err eyre-id 504 'unreachable or denied')
    ?.  ?=([%ball *] u.md)  (send-err eyre-id 404 'not found')
    (send-view eyre-id (render-page-titled canon "" "" (scow %p u.shp) (explore-dir-html u.shp pax ball.u.md)))
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
          (send-view eyre-id (render-page-titled canon "" "" (trip (rear pax)) (explore-dir-html u.shp pax ball.dn)))
        (render-page-view eyre-id u.shp pax u.pn ball.dn (~(has by args) 'embed') %.y)
      ;<  fn=view:nexus  bind:m  (peek:io file-road ~)
      ?.  ?=([%file *] fn)  (send-err eyre-id 404 'not found')
      ?:  want-raw  (send-raw eyre-id sang.fn %.y)
      (send-view eyre-id (render-page-titled canon "" "" (trip (rear pax)) (explore-file-html u.shp pax sang.fn %.y)))
    ;<  fn=view:nexus  bind:m  (peek:io file-road ~)
    ?:  ?=([%file *] fn)
      ?:  want-raw  (send-raw eyre-id sang.fn %.y)
      (send-view eyre-id (render-page-titled canon "" "" (trip (rear pax)) (explore-file-html u.shp pax sang.fn %.y)))
    ;<  dn=view:nexus  bind:m  (peek-shallow:io dir-road ~)
    ?.  ?=([%ball *] dn)  (send-err eyre-id 404 'not found')
    (send-redirect eyre-id (weld base "/"))
  ?:  slashed
    ;<  md=(unit view:nexus)  bind:m  (peek-remote-shallow-wait dir-road u.shp)
    ?~  md  (send-err eyre-id 504 'unreachable or denied')
    ?:  ?=([%ball *] u.md)
      ::  a peer's /page/<name>/ dir renders as the clearweb-style page (sandboxed
      ::  (untrusted html/js), unthemed, read-only), unless ?raw asks for the plain
      ::  grub listing. A plain folder (no /code grub) still browses as a listing.
      =/  pn=(unit @t)  (page-dir-name pax)
      =/  fils=(map @ta [=sang:tarball gain=? bang=(unit tang)])
        ?~(fil.ball.u.md ~ contents.u.fil.ball.u.md)
      ?:  |(?=(~ pn) ?!((~(has by fils) %code)) (~(has by args) 'raw'))
        (send-view eyre-id (render-page-titled canon "" "" (trip (rear pax)) (explore-dir-html u.shp pax ball.u.md)))
      (render-page-view eyre-id u.shp pax u.pn ball.u.md %.n %.n)
    ;<  mf=(unit view:nexus)  bind:m  (peek-remote-wait file-road u.shp)
    ?~  mf  (send-err eyre-id 504 'unreachable or denied')
    ?.  ?=([%file *] u.mf)  (send-err eyre-id 404 'not found')
    ?:  want-raw  (send-raw eyre-id sang.u.mf %.n)
    (send-view eyre-id (render-page-titled canon "" "" (trip (rear pax)) (explore-file-html u.shp pax sang.u.mf %.n)))
  ;<  mf=(unit view:nexus)  bind:m  (peek-remote-wait file-road u.shp)
  ?~  mf  (send-err eyre-id 504 'unreachable or denied')
  ?:  ?=([%file *] u.mf)
    ?:  want-raw  (send-raw eyre-id sang.u.mf %.n)
    (send-view eyre-id (render-page-titled canon "" "" (trip (rear pax)) (explore-file-html u.shp pax sang.u.mf %.n)))
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
::  The location carries a unique query so the follow-up GET can never be a
::  cache hit: these redirects exist to SHOW the result of the write that
::  just happened, and +send-view's stale-while-revalidate would otherwise
::  happily serve the pre-write document. Central here, so no call site can
::  forget it.
::
++  send-see-other
  |=  [eyre-id=@ta to=tape]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ;<  now=@da  bind:m  bowl-now
  =/  sep=tape  ?:(?=(^ (find "?" to)) "&" "?")
  =/  bust=tape  :(weld to sep "u=" (scow %ud (mod now 1.000.000.000)))
  %+  send-simple:srv  eyre-id
  [[303 ['location' (crip bust)]~] ~]
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
::  +render-page-view: the live view of one of our programmable pages,
::  rendered data + any error + a command form, with keep-SSE on the data
::  grub so a command from ANY browser reloads every open view (step 3).
::
++  render-page-view
  ::  `b` is the page dir's ball, ALREADY peeked by the caller (explore) to detect
  ::  the page dir. Reuse it instead of peeking the same dir again. The ball
  ::  carries every grub's contents, so data+err+share+show all come from it with
  ::  zero further round-trips.
  ::  embed=%.y (?embed): the bare rendered data + SSE, no chrome/crumbs/controls,
  ::  for the editor's live-preview iframe. Otherwise the full standalone view.
  ::  local=%.n: a PEER's page (browsed over ames), rendered in a SANDBOXED frame
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
  ::  names, never the payload, so keep="" to render-* and append a blot-free
  ::  stream here.
  =/  keep=tape  (keep-url "beacon/rev")
  ;<  rev=tape  bind:m  ?:(local beacon-rev-tape (pure:(fiber:fiber:nexus ,tape) ""))
  ?:  embed
    ::  bare preview: just the rendered data (+ any error) and the live stream.
    =/  data-html=tape  ?~(cd "<p>no data yet</p>" (render-shown u.cd vmode "/apps/lattice/app?name="))
    =/  errh=tape  ?:(=('' err) "" :(weld "<pre class=\"err\">" (esc (trip err)) "</pre>"))
    (send-html eyre-id (render-bare :(weld errh "<section class=\"data\">" data-html "</section>" (page-sse-script keep rev))))
  ::  standalone browser view: the page rendered exactly as it would publish. For
  ::  our own page the nearest theme is inlined (owner-gated, so it need not be
  ::  clearweb-shared) and it gets an Edit button + live-reload. A peer's page is
  ::  sandboxed and unthemed. No sharing/command controls. Those live in the
  ::  editor. `rel` strips the app-base/page/ prefix to the page-relative path that
  ::  find-theme-css/clearweb-doc expect (the same shape serve-clearweb passes).
  =/  rel=path  (slag 3 pax)
  ;<  head=tape  bind:m  (browser-head local vmode rel)
  ::  comments live in OUR tree, so only show them on OUR OWN pages. A peer's
  ::  page at a path that collides with one of ours must NOT surface our comments
  ::  or toggle. (Reading a peer's own comments waits for the cross-ship path.)
  ;<  ocon=?  bind:m  (comments-on rel)
  =/  con=?  &(local ocon)
  ::  our own view also gets a comment box (posts to /comment as us). A peer's box
  ::  (which posts to OUR nexus, which then pokes the peer) comes with the
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
  ::  the embed view (above) shows a crashed handler's err; the standalone
  ::  view a page-cmd's web=1 redirect actually lands on never did, so a
  ::  sender was bounced back to a quietly stale page with no sign anything
  ::  failed. Same markup here, in every branch this view can render.
  =/  errh=tape  ?:(=('' err) "" :(weld "<pre class=\"err\">" (esc (trip err)) "</pre>"))
  =/  doc=@t
    ?:  toobig  (render-clearweb (pax-str rel) head (weld errh "<p>page too large or not previewable</p>") "")
    ?~  cd  (render-clearweb (pax-str rel) head (weld errh "<p>no data yet</p>") "")
    ::  our own page view links into the editor; a peer's page keeps the
    ::  public form (we cannot link into their editor).
    =/  base=tape  ?:(local "/apps/lattice/app?name=" "/apps/lattice/c/")
    %-  clearweb-doc
    :*  rel  (render-shown u.cd vmode base)  vmode  head  ?!(?=(%html vmode))  ~
        (weld errh extra)
        ::  no bar: this document is the browser view's iframed inner page
        ""
    ==
  ::  the tab/history title: a real `#` heading in the page's own data (same
  ::  derivation +page-title-of runs everywhere else), else just the page's
  ::  own name. Always something more useful than the bare app name.
  =/  ttl=tape
    =/  txt=(unit @t)  ?~(cd ~ (mole |.(;;(@t (sang-noun:tarball u.cd)))))
    ?~  txt  (trip name)
    (trip (page-title-of u.txt name))
  ::  the long tier, LOCAL only: a local page view carries the live script
  ::  with a baked rev, so a cached paint self-corrects. A peer's page has
  ::  no stream — it keeps the short tier.
  =/  htm=@t
    %^    render-browser-page
        (trip (en-urb:lu shp pax))
      doc
    [?:(local `name ~) ?!(local) ?:(local keep "") ?:(local rev "") ttl]
  ?:  local  (send-view-long eyre-id htm)
  (send-view eyre-id htm)
::  +preview-inner: the rendered-preview HTML fragment for a page kind, the
::  single renderer behind POST /page-preview AND page-source?render=1, so the
::  editor preview can never drift from the reader. Wikilinkify only runs for
::  the markdown paths (it reads [[...]] syntax the other kinds do not have).
::
++  preview-inner
  |=  [ptype=@tas body=@t]
  ^-  tape
  ?+  ptype  (render-md:gfm (crip (wikilinkify:gfm (trip body) "/apps/lattice/app?name=")))
    %md    (render-md:gfm (crip (wikilinkify:gfm (trip body) "/apps/lattice/app?name=")))
    %gmi   (render-gmi body)
    %html  (trip body)
    %text  :(weld "<pre>" (esc (trip body)) "</pre>")
    %js    :(weld "<pre><code class=\"language-javascript\">" (esc (trip body)) "</code></pre>")
    %css   :(weld "<pre><code class=\"language-css\">" (esc (trip body)) "</code></pre>")
    %index  "<div style=\"color:#8a8a8a;text-align:center;padding:2rem\"><p><b>Folder index</b></p><p>Lists the pages in this page's folder automatically, once you name it (e.g. blog/index) and save. Live as pages come and go.</p></div>"
  ==
::  +render-bare: a minimal HTML doc (shared reader CSS, no address-bar chrome),
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
::  +render-clearweb: the standalone public shell for a %clearweb page, a bare
::  html document, NO lattice chrome. `head` is raw <head> content (the theme
::  <link> or a <style>), placed in the HEAD so it is render-blocking: the page
::  paints WITH its background and never flashes white on navigation. A
::  color-scheme meta makes even the pre-CSS canvas follow the OS theme. The
::  public mirror of +render-page (the owner's authenticated explorer chrome).
::
++  render-clearweb
  |=  [title=tape head=tape inner=tape bar=tape]
  ^-  @t
  %-  crip
  ;:  weld
    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">"
    "<meta name=\"color-scheme\" content=\"light dark\">"
    "<title>"  (esc title)  "</title>"
    head
    "</head><body>"  bar  inner  "</body></html>"
  ==
::  +clearweb-bar: the /c/ navigation affordance, in two tiers. EVERYONE
::  gets contextual back/forward — pure history traversal, no auth, so an
::  anonymous visitor is never stranded on a bare page. The authenticated
::  OWNER also gets the omnibar + Go + the hamburger; those are owner tools
::  (the reader routes behind them are owner-gated and would only bounce a
::  visitor to a login). Self-contained styles: public pages wear their own
::  theme css, not web-css. +nav-script wires the buttons either way.
::
++  clearweb-bar
  |=  authed=?
  ^-  tape
  ::  single-quote cords: braces in a double-quoted tape INTERPOLATE.
  %+  weld
    %-  trip
    '<style>.cbar{display:flex;gap:6px;align-items:center;padding:6px 8px;border-bottom:1px solid #8884}.cbar button,.cbar a.home{font:inherit;padding:4px 12px;border:1px solid #8886;border-radius:6px;background:transparent;color:inherit;cursor:pointer;text-decoration:none}.cbar button[disabled]{opacity:.35;cursor:default}.cbar input{flex:1;font:inherit;padding:5px 8px;border:1px solid #8886;border-radius:6px;background:transparent;color:inherit}.cbar .hamw{position:relative;margin-left:auto;display:flex}#hammenu{position:absolute;right:0;top:100%;z-index:60;background:#fff;border:1px solid #8886;border-radius:6px;min-width:160px;display:flex;flex-direction:column;padding:4px;box-shadow:0 4px 14px #0003}@media(prefers-color-scheme:dark){#hammenu{background:#1a1a1a}}#hammenu a{padding:7px 10px;text-decoration:none;color:inherit;border-radius:4px}#hammenu a:hover{background:#8882}#hammenu[hidden]{display:none}</style><form class="cbar" action="/apps/lattice" method="get"><button type="button" class="navb" id="navb" title="back" disabled>&#8592;</button><button type="button" class="navb" id="navf" title="forward" disabled>&#8594;</button>'
  ?.  authed  "</form>"
  %-  trip
  '<a class="home" href="/apps/lattice" title="lattice home">&#8962;</a><input name="url" value="" autocomplete="off" placeholder="urb:// address or search your pages"><button type="submit">Go</button><span class="hamw"><button type="button" id="ham" title="menu">&#9776;</button><div id="hammenu" hidden><a href="/apps/lattice/app">&#9998; editor</a><a href="/apps/lattice/know">&#9670; knowledge</a><a href="/apps/lattice/marks">&#9733; bookmarks</a><a href="/apps/lattice/settings">&#9881; settings</a></div></span></form>'
::  `preview`: the editor's preview frame asked (?preview=1). An html answer
::  gets the editor's flat scrollbar rules appended, because a document that
::  styles no scrollbars gets the engine's native, window-theme-following ones
::  (white in a dark editor on WebKitGTK). Appended, not prepended, so the
::  doctype still leads and parsing is unchanged; the rules touch scrollbars
::  only. Anything fetched for real (no flag) is served byte for byte.
++  serve-asset
  |=  [eyre-id=@ta pax=path preview=?]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  ?.  (levy pax |=(seg=@ta ((sane %ta) seg)))  (send-err eyre-id 404 'not found')
  =/  pdir=path  (weld /page pax)
  ;<  dsn=view:nexus  bind:m  (peek:io (rf up pdir %data) ~)
  ?.  ?=([%file *] dsn)  (send-err eyre-id 404 'not found')
  ;<  vmode=view-mode:pg  bind:m  (read-show-mode pdir)
  =/  res=(each @t tang)  (mule |.(;;(@t (sang-noun:tarball sang.dsn))))
  ?:  ?=(%| -.res)  (send-err eyre-id 415 'not servable')
  =/  body=@t
    ?.  &(preview ?=(%html vmode))  p.res
    (cat 3 p.res preview-scrollbar-css)
  (send-typed eyre-id (mime-of vmode) 'no-cache' body)
++  preview-scrollbar-css
  ^-  @t
  %+  rap  3
  :~  '<style>:root{color-scheme:light dark}html::-webkit-scrollbar{display:none}</style>'
      ::  height reporter: the editor sizes the preview frame to its content and
      ::  scrolls the pane itself; the frame's own (light-on-WebKitGTK) bar is
      ::  hidden above. Same text as previewFit in 60-preview.js, minus the seq.
      '<script>(function(){function s(){var d=document.documentElement,b=document.body;parent.postMessage({latPrev:Math.max(d.scrollHeight,b?b.scrollHeight:0)},"*")}addEventListener("load",function(){s();if(document.body)new ResizeObserver(s).observe(document.body)})})()</script>'
  ==
::  +find-theme: the nearest folder AT or ABOVE pax's parent holding a clearweb
::  css `theme` page, so a rendered clearweb page auto-inherits a site theme
::  (nearest wins, a subfolder theme overrides). ~ if none up to the root.
::  ponytail: a few peeks per rendered request. The theme link is then browser-
::  cached across the site. Add a cache here only if it ever measures hot.
::
++  find-theme
  |=  pax=path
  =/  m  (fiber:fiber:nexus ,(unit path))
  ^-  form:m
  =/  anc=path  (snip `path`pax)
  |-  ^-  form:m
  =/  tdir=path  (weld /page (weld anc /theme))
  ;<  mode=share-mode:le  bind:m  (read-share tdir)
  ;<  show=view-mode:pg   bind:m  (read-show-mode tdir)
  ?:  &(?=(%clearweb mode) ?=(%css show))  (pure:m `anc)
  ?~  anc  (pure:m ~)
  $(anc (snip `path`anc))
::  +clearweb-doc: the standalone chrome-less document for a page. Theme in the
::  <head>, body per view-mode. %html inlines raw (owns its own layout); a
::  md/gmi/text/noun body is wrapped in <main class="page"> (with an optional home
::  link) when `wrap`; css/js show as a code block. `head` is the caller's theme
::  <head> (a <link>, inline <style>, or the default reader css). Shared by
::  serve-clearweb (/c/, links a shared theme) and the browser page view (owner-
::  gated, inlines any theme). On PEER data it is only ever rendered inside a
::  sandboxed frame. The sandbox, not escaping, is what neutralizes hostile html.
::
++  clearweb-doc
  |=  [pax=path shown=tape vmode=view-mode:pg head=tape wrap=? home=(unit tape) extra=tape bar=tape]
  ^-  @t
  ::  `shown` is the page body already rendered for its mode (+render-shown,
  ::  or the cached copy +clearweb-body serves on the public path).
  ::  `extra` (a rendered comment thread + optional box) is appended after the
  ::  page content, inside the themed wrapper for md/gmi/text, or after the raw
  ::  body for %html.
  ::  `base` is the wikilink target root: /c/ on the public surface, the editor
  ::  on an owner view. Hardcoding /c/ here made every wikilink on the owner's
  ::  own page view dead, since pages are private by default.
  =/  inner=tape  (weld shown extra)
  =/  body=tape
    ?:  ?=(%html vmode)  inner
    ?.  wrap  inner
    =/  hlink=tape
      ?~  home  ""
      :(weld "<p class=\"home\"><a href=\"" (esc u.home) "\">&larr; home</a></p>")
    :(weld "<main class=\"page\">" hlink inner "</main>")
  (render-clearweb (pax-str pax) head body bar)
::  +comment-walk: every comment under /comments, with the page it belongs to.
::  Recurses the ball once rather than per-page. The owner wants "what came
::  in", which is a question about the whole tree, not about a page they
::  already know to look at.
++  comment-walk
  |=  [b=ball:tarball rel=path]
  ^-  (list [pax=path id=@ta c=comment:lc])
  =/  fils=(map @ta [=sang:tarball gain=? bang=(unit tang)])
    ?~(fil.b ~ contents.u.fil.b)
  =/  here=(list [pax=path id=@ta c=comment:lc])
    ?~  rel  ~                      ::  a comment cannot live in the root
    %+  murn  ~(tap by fils)
    |=  [id=@ta s=sang:tarball gain=? bang=(unit tang)]
    ^-  (unit [path @ta comment:lc])
    =/  c=(unit comment:lc)  (mole |.(;;(comment:lc (sang-noun:tarball s))))
    ?~  c  ~
    `[rel id u.c]
  %-  zing
  :-  here
  %+  turn  ~(tap by dir.b)
  |=  [nom=@ta kb=ball:tarball]
  (comment-walk kb (weld rel /[nom]))
::  +comments-inbox-json: the owner's view of comments across every page.
::  Newest first and capped. This is a list other ships append to, so it is
::  bounded on read for the same reason the shares inbox is bounded on write.
++  comments-inbox-json
  =/  m  (fiber:fiber:nexus ,json)
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  ;<  sn=view:nexus  bind:m  (peek:io (rv up /comments) ~)
  ?.  ?=([%ball *] sn)  (pure:m (pairs:enjs:format ~[['items' a+~]]))
  =/  all=(list [pax=path id=@ta c=comment:lc])  (comment-walk ball.sn ~)
  =/  sorted=(list [pax=path id=@ta c=comment:lc])
    %+  sort  all
    |=  [a=[* * c=comment:lc] b=[* * c=comment:lc]]
    (gth when.c.a when.c.b)
  =/  js=(list json)
    %+  turn  (scag 200 sorted)
    |=  [pax=path id=@ta c=comment:lc]
    %-  pairs:enjs:format
    :~  ['page' s+(crip (pax-str pax))]
        ['id' s+id]
        ['author' s+(scot %p author.c)]
        ['when' s+(scot %da when.c)]
        ['body' s+body.c]
    ==
  (pure:m (pairs:enjs:format ~[['items' a+js] ['total' (numb:enjs:format (lent all))]]))
::  +render-comments: the comment thread for `page` (page-relative path) as escaped
::  html, oldest first. `box` is an optional trailing comment form (browser views
::  only). "" when the page has no comments and no box. Read here (a peek) rather
::  than in the pure +clearweb-doc. The result is passed in as its `extra`.
::
++  render-comments
  |=  [page=path on=? box=tape]
  =/  m  (fiber:fiber:nexus ,tape)
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  ?.  on  (pure:m "")
  ;<  seen=view:nexus  bind:m  (peek:io (rv up (weld /comments page)) ~)
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
::  css text, for the owner-gated browser view, which (unlike /c/) themes a page
::  whose theme need not be clearweb-shared, so it inlines rather than links. ~ if
::  none up to the root. A nearer theme whose data is unreadable is skipped.
::
++  find-theme-css
  |=  pax=path
  =/  m  (fiber:fiber:nexus ,(unit @t))
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  =/  anc=path  (snip `path`pax)
  |-  ^-  form:m
  =/  tdir=path  (weld /page (weld anc /theme))
  ;<  show=view-mode:pg  bind:m  (read-show-mode tdir)
  ?:  ?=(%css show)
    ;<  dsn=view:nexus  bind:m  (peek:io (rf up tdir %data) ~)
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
::  +forms-on: is public form submission enabled at or above this page? Same
::  nearest-flag-wins walk as +comments-on, so a folder opts in a whole site.
::
++  forms-on
  |=  page=path
  =/  m  (fiber:fiber:nexus ,?)
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  |-  ^-  form:m
  =/  fdir=path  (weld /page page)
  ;<  seen=view:nexus  bind:m  (peek:io (rf up fdir %forms-on) ~)
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
  ;<  up=@ud  bind:m  nexus-up
  |-  ^-  form:m
  =/  fdir=path  (weld /page page)
  ;<  seen=view:nexus  bind:m  (peek:io (rf up fdir %'forms-cfg') ~)
  ?:  ?=([%file *] seen)
    (pure:m (fall (mole |.(;;(form-cfg:le (sang-noun:tarball sang.seen)))) [0 *@dr]))
  ?~  page  (pure:m [0 *@dr])
  $(page (snip `path`page))
::  +read-form-use: a page's submission tally. EXACT, never inherited.
::
++  read-form-use
  |=  page=path
  =/  m  (fiber:fiber:nexus ,form-use:le)
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  =/  fdir=path  (weld /page page)
  ;<  seen=view:nexus  bind:m  (peek:io (rf up fdir %'forms-use') ~)
  ?.  ?=([%file *] seen)  (pure:m [0 *@da])
  (pure:m (fall (mole |.(;;(form-use:le (sang-noun:tarball sang.seen)))) [0 *@da]))
::  +serve-form: accept a public form POST for a page and deliver it as a
::  command. Requires clearweb + forms-on. The body is capped, and the reply
::  is a redirect back to the page so a plain <form> works with no JS.
::
++  serve-form
  |=  [eyre-id=@ta pax=path body=@t]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  ?.  (levy pax |=(seg=@ta &(!=(%$ seg) ((sane %ta) seg))))
    (send-err eyre-id 404 'not found')
  =/  pdir=path  (weld /page pax)
  ;<  mode=share-mode:le  bind:m  (read-share pdir)
  ?.  ?=(%clearweb mode)  (send-err eyre-id 404 'not found')
  ;<  on=?  bind:m  (forms-on pax)
  ?.  on  (send-err eyre-id 403 'forms not enabled')
  ;<  ex=?  bind:m  (peek-exists:io (rf up pdir %code))
  ?.  ex  (send-err eyre-id 404 'not found')
  ?:  (gth (met 3 body) form-body-max)  (send-err eyre-id 413 'too large')
  ::  the two owner-set limits. Both are checked HERE rather than in the writer
  ::  so a refused submission gets an honest 429 instead of a 303 that pretends
  ::  it landed. The cost is that a simultaneous burst can overshoot the cap by
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
::  +serve-clearweb: the public read of a %clearweb page. Read-only, data grub
::  only. A non-clearweb (or absent) page is a flat 404 so private siblings
::  never leak existence. No SSE (an anon keep would 403 anyway).
::
++  serve-clearweb
  |=  [eyre-id=@ta pax=path authed=?]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  ::  same per-segment gate as name-pax/serve-asset: non-empty %ta knots only,
  ::  so a trailing '/' ('' segment) and '.'/'..' 404: no traversal, no folder
  ::  listing. (The route's [%c ^] already rejects a bare /c/.) The per-leaf
  ::  %clearweb check below is the only public/private gate.
  ?.  (levy pax |=(seg=@ta &(!=(%$ seg) ((sane %ta) seg))))
    (send-err eyre-id 404 'not found')
  =/  pdir=path  (weld /page pax)
  ;<  mode=share-mode:le  bind:m  (read-share pdir)
  ?.  ?=(%clearweb mode)  (send-err eyre-id 404 'not found')
  ;<  dsn=view:nexus  bind:m  (peek:io (rf up pdir %data) ~)
  ;<  vmode=view-mode:pg  bind:m  (read-show-mode pdir)
  ?.  ?=([%file *] dsn)
    (send-html eyre-id (render-clearweb (pax-str pax) "" "<p>no data</p>" (weld (clearweb-bar authed) nav-script)))
  ::  css/js serve RAW (a public page links them as a stylesheet/script, so they
  ::  must NOT go through render-shown's <pre><code> wrap). Everything else
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
  ::  here, no comment box (box=""). Commenting happens from a ship's browser.
  ;<  con=?    bind:m  (comments-on pax)
  ;<  cmts=tape  bind:m  (render-comments pax con "")
  ;<  shown=tape  bind:m  (clearweb-body pdir sang.dsn ud.cass.dsn vmode "/apps/lattice/c/")
  %+  send-html  eyre-id
  %:  clearweb-doc
    pax  shown  vmode  head  ?=(^ tf)  home  cmts
    (weld (clearweb-bar authed) nav-script)
  ==
::  +clearweb-body: the rendered body of a public page, from a per-page cache
::  keyed by the data grub's revision. The md and gmi renders are the costly
::  part of an unauthenticated hit (quadratic on hostile input, see
::  docs/perf-review.md), and they are pure in the page's data, its show mode
::  and a constant base, so a hit at the same revision can reuse the last
::  render. The other modes are a pass-through or a single escape and are
::  not cached. No invalidation exists or is needed: a save bumps the
::  revision, a show-mode change mismatches the mode, a delete takes the
::  page dir and the cache grub with it. Two concurrent misses render twice
::  and write the same bytes.
::
++  clearweb-body
  |=  [pdir=path =sang:tarball rev=@ud vmode=view-mode:pg base=tape]
  =/  m  (fiber:fiber:nexus ,tape)
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  ?.  ?=(?(%md %gmi) vmode)  (pure:m (render-shown sang vmode base))
  =/  road=road:tarball  (rf up pdir %'render.json')
  =/  want=@t  (scot %ud rev)
  ;<  cv=view:nexus  bind:m  (peek:io road ~)
  =/  hit=(unit tape)
    ?.  ?=([%file *] cv)  ~
    =/  jon=json  (fall (mole |.(!<(json (need-vase:tarball sang.cv)))) ~)
    ?.  ?=([%o *] jon)  ~
    =/  r=(unit json)  (~(get by p.jon) 'rev')
    =/  d=(unit json)  (~(get by p.jon) 'mode')
    =/  h=(unit json)  (~(get by p.jon) 'html')
    ?.  &(?=([~ %s *] r) ?=([~ %s *] d) ?=([~ %s *] h))  ~
    ?.  &(=(p.u.r want) =(p.u.d vmode))  ~
    `(trip p.u.h)
  ?^  hit  (pure:m u.hit)
  =/  html=tape  (render-shown sang vmode base)
  ;<  ~  bind:m
    %^  put-file  road  [/ %json]
    %-  pairs:enjs:format
    :~  ['rev' s+want]
        ['mode' s+vmode]
        ['html' s+(crip html)]
    ==
  (pure:m html)
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
::  inlines raw, safe because this is only ever called on OUR OWN page data
::  (render-page-view / serve-clearweb). A peer's page data is escaped by the
::  explorer, never routed here. A non-cord value falls back to a noun literal.
::
::  wikilinkify (rewrite [[name]] / [[name|label]] before md render) lives in
::  /lib/lattice-md (imported here as `gfm`), alongside render-md, so both
::  ends of markdown rendering share one pure, unit-tested core.
::
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
    %md    =/  wl=@t  (crip (wikilinkify:gfm (trip p.cr) base))
           (render-md:gfm wl)
    %js    :(weld "<pre><code class=\"language-javascript\">" (esc (trip p.cr)) "</code></pre>")
    %css   :(weld "<pre><code class=\"language-css\">" (esc (trip p.cr)) "</code></pre>")
    %noun  (page-data-html sang)
  ==
::  +page-sse-script: like +sse-script but WITHOUT ?blot=/txt. The page dir's
::  noun grubs are megabytes under /txt on connect, and this only needs the
::  event names. Same refresh/swap loop otherwise.
::
++  page-sse-script
  |=  [keep=tape rev=tape]
  ^-  tape
  ?~  keep  ""
  ;:  weld
    (trip '<script>(function(){var K="')
    keep
    (trip '";var REV="')
    rev
    %-  trip
    '";var pend=0,ac=null,live=false;function upd(){pend++;if(pend===1){(function go(){var n=pend;window.__latRefresh(true).then(function(ok){if(pend>n){setTimeout(go,1500);return}if(ok&&ok.chg&&window.__latCanon){pend=0;location.replace(window.__latCanon);return}if(!ok){location.reload();return}pend=0})})()}}async function c(){if(live||document.hidden)return;live=true;ac=new AbortController();try{var r=await fetch(K,{headers:{Accept:"text/event-stream"},signal:ac.signal});if(r.redirected||r.url.indexOf("/~/login")>=0)return;var R=r.body.getReader();var d=new TextDecoder();var b="";while(true){var x=await R.read();if(x.done)break;b+=d.decode(x.value,{stream:true});var ps=b.split("\\n\\n");b=ps.pop();for(var i=0;i<ps.length;i++){if(!ps[i].trim())continue;var ev="",dt="";var ls=ps[i].split("\\n");for(var j=0;j<ls.length;j++){if(ls[j].indexOf("event: ")===0)ev=ls[j].slice(7);else if(ls[j].indexOf("data: ")===0)dt=ls[j].slice(6)}if(!ev)continue;if(ev.slice(-5)!==" /rev")continue;if(ev.slice(0,3)==="old"){if(REV&&dt&&dt.trim()!==REV){if(window.__latRefresh){window.__latRefresh()}else{location.reload();return}}continue}if(window.__latRefresh){if(!document.hidden)upd();continue}location.reload();return}}}catch(x){}live=false;if(!document.hidden)setTimeout(c,3000)}document.addEventListener("visibilitychange",function(){if(document.hidden){if(ac)ac.abort();return}if(window.__latRefresh)upd();setTimeout(c,200)});c()})();</script>'
  ==
::  +explore-crumbs: breadcrumb nav, absolute hrefs from the ship root down,
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
  ::  esc the href too. Remote segment names are attacker-chosen text.
  =.  out  :(weld out " / <a href=\"" (esc cur) "/\">" (esc (trip i.pax)) "</a>")
  $(pax t.pax)
::  +explore-dir-html: one directory level as HTML, subdirs first, then files
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
::  html inlines as-is (hawk's model: data is its own ui. This surface is
::  owner-only until the clearweb step), everything else is an escaped <pre>.
::  Non-cord bodies: octs get a byte count + raw link; opaque nouns just the
::  mark. ?data is always offered for cord/octs bodies.
::
++  explore-file-html
  |=  [shp=@p pax=path =sang:tarball local=?]
  ^-  tape
  =/  mk=@tas  name.p.sang
  =/  nn=*  (sang-noun:tarball sang)
  ::  fold /txt wains into the cord path up front so they preview and cap like
  ::  any text file instead of falling through to "binary grub".
  =/  cord-res=(each @t tang)
    =/  c=(each @t tang)  (mule |.(;;(@t nn)))
    ?:  ?=(%& -.c)  c
    =/  wn=(each wain tang)  (mule |.(;;(wain nn)))
    ?:  ?=(%& -.wn)  [%& (of-wain:format p.wn)]
    c
  =/  body=tape
    ?:  ?=(%& -.cord-res)
      ::  cap the rendered preview: esc+weld would double a multi-MB body into
      ::  one response. ponytail: peek already loaded it; this bounds the render
      ::  doubling, and ?data still serves the full bytes.
      ?:  (gth (met 3 p.cord-res) (bex 20))
        "<p>file too large to preview &mdash; <a href=\"?data\">view raw</a></p>"
      ::  %page is the lattice pub blot ([/lattice %page]), gemtext bodies.
      ::  %html inlines RAW, but only for our OWN grubs (local). A foreign
      ::  ship's %html body is attacker-controlled, so escape it (stored XSS
      ::  in the owner's browser otherwise; caught by review).
      ?+  mk  :(weld "<pre>" (esc (trip p.cord-res)) "</pre>")
        ?(%gmi %gemtext %page)  (render-gmi p.cord-res)
        %html
      ?:  local  (trip p.cord-res)
      :(weld "<pre>" (esc (trip p.cord-res)) "</pre>")
      ==
    ::  a %json grub holds a json NOUN. Re-encode it rather than calling it
    ::  opaque, and check this BEFORE the octs shape, because some json nouns
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
    ::  what they are rather than "opaque noun": HTML in a FRAME, never inlined.
    ::  Inlining would run the asset's scripts in our origin with the owner's
    ::  session. Foreign frames get no scripts at all.
    =/  mime-res=(each mime tang)  (mule |.(;;(mime nn)))
    ?:  ?=(%& -.mime-res)
      =/  mt=path  p.p.mime-res
      =/  n=@ud   p.q.p.mime-res
      ?:  ?=([%text %html *] mt)
        %+  weld
          ::  OUR OWN asset: same-origin, so the app can authenticate its own
          ::  data fetches and actually work. Without it the frame gets an
          ::  opaque origin, requests go out cookieless, and e.g. a calendar
          ::  renders its chrome with no events. This is our own installed
          ::  code, already running on this ship, so it is not new exposure.
          ::  A FOREIGN asset stays fully sandboxed: no scripts at all.
          ?:  local  "<iframe class=\"rawf\" src=\"?data\" sandbox=\"allow-scripts allow-forms allow-same-origin allow-popups\"></iframe>"
          "<iframe class=\"rawf\" src=\"?data\" sandbox=\"\"></iframe>"
        :(weld "<p class=\"muted\">" (spud mt) " &middot; " (a-co:co n) " bytes &middot; <a href=\"?data\">open raw</a></p>")
      ::  <img> renders svg WITHOUT executing its scripts, so it is safe for
      ::  foreign content too, unlike an inline <svg> or an iframe.
      ?:  ?=([%image *] mt)
        :(weld "<p><img src=\"?data\" alt=\"\"></p>" (mime-note mt n))
      ?:  ?=([%audio *] mt)
        :(weld "<p><audio controls src=\"?data\"></audio></p>" (mime-note mt n))
      ?:  ?=([%video *] mt)
        :(weld "<p><video controls class=\"rawf\" src=\"?data\"></video></p>" (mime-note mt n))
      ?:  ?=([%application %pdf *] mt)
        :(weld "<iframe class=\"rawf\" src=\"?data\" sandbox=\"\"></iframe>" (mime-note mt n))
      ::  text-ish assets (css, js, json, markdown, plain) are the bulk of an
      ::  app's tree. Show the CONTENT, not just a size and a link.
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
  ::  edit link: any grub with recoverable text. A remote link carries the ship
  ::  and saves go back over ames as weir-gated writes. Whether the peer
  ::  ACCEPTS the write is their weir's decision at save time, which the editor
  ::  surfaces. Hiding the affordance here would be guessing their ACL for them.
  ::  Binary/opaque grubs get no link. A text round-trip would destroy them.
  =/  editable=?  ?=(^ (grub-text sang))
  =/  edit-link=tape
    ?.  editable  ""
    ::  +spud, not +pax-str: the route parses this with +stab, which requires the
    ::  leading slash. pax-str omits it, so every edit link 400'd.
    =/  ship-arg=tape
      ?:  local  ""
      :(weld "&ship=" (scow %p shp))
    :(weld " &middot; <a href=\"/apps/lattice/app?grub=" (esc (spud pax)) ship-arg "\">edit</a>")
  ;:  weld
    (explore-crumbs shp pax)
    "<div class=\"meta\">mark "  (esc (trip mk))
    " &middot; <a href=\"?data\">raw</a>"  edit-link  "</div>"
    body
  ==
::  +send-raw: ?data, the file body verbatim with a mark-derived content-type.
::  Cords ship as their bytes. octs ship as-is. Anything else is 415.
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
  ::  a %mime grub carries its OWN type ([mite octs]), an app's asset, e.g.
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
    ::  p is remote-attested (a boom carries the peer's raw noun). A hostile
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
::  text/plain. Cords are overwhelmingly text, and octs of unknown mark are
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
::  a JSON listing, subdirs first, then files. Each file carries its mark leaf. Both
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
::  content is a boom (raw noun), so clam to @t in a mule. A non-text file (or a
::  hostile non-cord body) is a clean 415, never a crash.
::
++  browse-file-respond
  |=  [eyre-id=@ta sn=view:nexus]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ?.  ?=([%file *] sn)  (send-err eyre-id 404 'not a file')
  ::  +grub-text, not a bare @t clam: cord bodies, /txt wains and mime grubs
  ::  are all text a remote editor can round-trip. editable mirrors
  ::  /grub-source's contract so the client can grey out what it must not save.
  =/  txt=(unit @t)  (grub-text sang.sn)
  ?~  txt  (send-err eyre-id 415 'not text')
  %+  send-json  eyre-id
  %-  pairs:enjs:format
  :~  ['body' s+u.txt]
      ['mark' s+name.p.sang.sn]
      ['editable' b+&]
  ==
::  +send-html: a 200 text/html response.
::
++  send-html
  |=  [eyre-id=@ta htm=@t]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  %+  send-simple:srv  eyre-id
  :-  [200 ['content-type' 'text/html']~]
  `(as-octs:mimes:html htm)
::  +view-cache / +view-long-cache: the cache policy each tier sends. The two
::  values are the same today. They are named apart because the long tier's knob
::  may want retuning on its own, so change one without touching the other.
::
++  view-cache       ^-(@t 'private, max-age=5, stale-while-revalidate=600')
++  view-long-cache  ^-(@t 'private, max-age=5, stale-while-revalidate=600')
::  +send-view: a text/html 200 plus a cache policy for navigable read surfaces
::  (home, tree explorer, reader AND page views). Every request to this pier
::  costs a flat ~2s regardless of payload, so the only way a repeat visit
::  gets fast is not making the request: max-age=5 covers back/forward, and
::  stale-while-revalidate covers the real browsing pattern — a repeat click
::  minutes later paints INSTANTLY from cache while the browser refetches in
::  the background, so the next view is fresh. Live changes on own-ship
::  documents still land immediately via the beacon SSE (refresh the pages
::  cache, then swap to it).
::
::  Page views carry the command/comment forms, which used to be why they
::  were excluded (a 303-then-GET served from cache would hide the user's
::  own edit). That objection is retired centrally: +send-see-other now
::  busts its redirect with a unique query, so every read-after-write GET
::  misses the cache by construction. The one accepted staleness: a page
::  changed by OTHER means (an editor save, a remote edit) can paint one
::  stale view within the revalidate window before the background refresh
::  or the beacon corrects it.
::
++  send-view
  |=  [eyre-id=@ta htm=@t]
  (send-typed eyre-id 'text/html' view-cache htm)
::  +send-view-long: the tier for LIVE local surfaces — pages that carry the
::  beacon script with a baked rev plus +page-cache-script. Instant repeats
::  are the LRU pages cache's job now (sw-js serves them before HTTP ever
::  sees the request), so max-age dropped from 300 back to 5: the long
::  window's only remaining consumers were ?u=-stamped history entries and
::  SW-less browsers, and both were serving up-to-5-minute-old snapshots
::  that the quiet-convergence regime no longer reloads. Kept as its own
::  tier (not collapsed into +send-view) because these are exactly the
::  surfaces the pages cache may serve stale-then-converge, and the knob
::  may want retuning separately from plain read surfaces.
::
++  send-view-long
  |=  [eyre-id=@ta htm=@t]
  (send-typed eyre-id 'text/html' view-long-cache htm)
::  ── PWA (installable app) ──────────────────────────────────────────────────
::  Content-Type is an explicit header cord here (not mark-derived), so a
::  manifest and a service worker are served with correct MIME by hand. All PWA
::  routes sit AFTER the owner gate, so they're owner-only. The browser fetches
::  them same-origin with the session cookie, which is the right posture for a
::  private app (install is offered only inside an authed session).
::
::  +send-typed: a 200 with an explicit content-type and cache-control. The PWA
::  routes and both +send-view tiers send through it.
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
::  scope /apps/lattice, start_url the editor INSIDE that scope. One SVG
::  icon covers Android/desktop install; iOS uses the apple-touch-icon PNG.
::
++  manifest-json
  ^-  @t
  ::  start_url is the EDITOR: a PWA always launches at start_url, so pointing
  ::  it at the reader landing page meant every launch opened "home" and never
  ::  the page you were working in (boot's snapshot-resume does the rest).
  ::  `id` is explicit and must NOT follow start_url: id is the install's
  ::  identity, and changing it would orphan every existing home-screen icon.
  ::  NB WebAPK lag: Android applies manifest changes on its own schedule.
  ::  Remove + re-add to the home screen picks this up immediately.
  ::  share_target makes the installed PWA appear in the mobile share sheet.
  ::  Sharing a page to Lattice archives it, same as the bookmarklet. GET (not
  ::  POST) deliberately: the OS then performs a top-level NAVIGATION, which
  ::  carries the eyre session cookie. A POST share target would be a
  ::  cross-site form post and arrive unauthenticated. The action must sit
  ::  inside `scope`. All three params are declared because senders disagree
  ::  about which one carries the url (see +first-url).
  '{"id":"/apps/lattice","name":"Lattice","short_name":"Lattice","description":"Programmable pages and markdown notes on Urbit.","start_url":"/apps/lattice/app","scope":"/apps/lattice","display":"standalone","theme_color":"#101541","background_color":"#fafafa","share_target":{"action":"/apps/lattice/share","method":"GET","params":{"title":"title","text":"text","url":"url"}},"icons":[{"src":"/apps/lattice/icon-192.png","sizes":"192x192","type":"image/png","purpose":"any"},{"src":"/apps/lattice/icon-512.png","sizes":"512x512","type":"image/png","purpose":"any"},{"src":"/apps/lattice/icon-512.png","sizes":"512x512","type":"image/png","purpose":"maskable"},{"src":"/apps/lattice/icon.svg","sizes":"any","type":"image/svg+xml","purpose":"any"}]}'
++  icon-svg
  ^-  @t
  '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><defs><radialGradient id="bg" cx="50%" cy="50%" r="72%"><stop offset="0" stop-color="#171c52"/><stop offset="0.6" stop-color="#101541"/><stop offset="1" stop-color="#080b25"/></radialGradient></defs><rect width="512" height="512" fill="url(#bg)"/><g stroke="#f9a804" stroke-width="14" stroke-linecap="round" fill="#f9a804"><line x1="140" y1="140" x2="372" y2="140"/><line x1="140" y1="256" x2="372" y2="256"/><line x1="140" y1="372" x2="372" y2="372"/><line x1="140" y1="140" x2="140" y2="372"/><line x1="256" y1="140" x2="256" y2="372"/><line x1="372" y1="140" x2="372" y2="372"/><line x1="140" y1="140" x2="372" y2="372"/><line x1="372" y1="140" x2="140" y2="372"/><circle cx="140" cy="140" r="26"/><circle cx="256" cy="140" r="26"/><circle cx="372" cy="140" r="26"/><circle cx="140" cy="256" r="26"/><circle cx="256" cy="256" r="30"/><circle cx="372" cy="256" r="26"/><circle cx="140" cy="372" r="26"/><circle cx="256" cy="372" r="26"/><circle cx="372" cy="372" r="26"/></g></svg>'
::  the service worker: stale-while-revalidate for the app SHELL (editor HTML,
::  app.js, vault.js, prism, icons, manifest). A warm boot serves every asset
::  from the SW cache at 0ms and refreshes it in the background, so it is at
::  most one load behind a deploy.
::  A new worker also RELOADS the page once it takes over. Without that the
::  visit that picks up a deploy still runs the code it loaded before the
::  worker changed, so every deploy served one full visit of stale UI and a
::  fix looked like it had not shipped. The reload is skipped while the
::  editor holds unsaved text, which is why the bundle exports __latUnsaved.
::  install PRECACHES the shell. Filling it lazily on a fetch miss meant the
::  visit that missed paid the full pier round-trip for every asset, so a new
::  install took three visits to go fast: one to register, one to miss and
::  fill, one to finally hit. That third-visit cliff reappeared on every
::  deploy, because a new V empties the shell cache. Assets are added one by
::  one, since addAll fails the whole install if any single asset 404s. (The fetch handler is genuinely cache-FIRST: an
::  earlier version awaited the network before answering, which paid the full
::  pier round-trip per asset per boot and made the cache pure fallback.)
::  On a cache HIT the revalidation is DELAYED (5s, held open by waitUntil).
::  The shell and app.js are `no-cache`, so they re-fetch on every boot, and
::  the pier serializes. Issued immediately they put two round-trips ahead of
::  page-dump, the one request the editor is actually waiting for. Deferring
::  costs nothing (the answer was served from cache) and still picks the
::  deploy up within the same session. waitUntil is guarded: if the event has
::  already finished, revalidate inline rather than skip it.
::  The /app HTML is cached by pathname, so ?name= deep
::  links share one entry. API routes stay network-only: every one is
::  auth-gated and dynamic, and a stale authed response must never be served.
::  No precache. A logged-out install would 403 and abort.
::
::  Non-SHELL requests are NOT intercepted at all (no respondWith): some
::  webkitgtk builds drop cookies on SW-mediated fetch, so a blanket
::  passthrough turned every API call cookieless in the desktop webview
::  ("tree failed 403" while the document itself authenticated fine). The
::  offline nicety it bought is not worth re-breaking that.
::
::  BUMP V WHENEVER index.html CHANGES. "at most one load behind" assumes the
::  delayed revalidate actually lands, and on the desktop's webkitgtk webview
::  an idle worker can be killed before the 5s timer fires — then the cache is
::  stale forever, not for one load. app.js recovers on the next boot either
::  way; the HTML document cannot, because the stale shell IS the running page.
::  v6 -> v7: #134 added <lat-conflicts> to index.html, so every client kept
::  serving a shell with no conflicts element and the badge never appeared.
::  Changing V is the only reliable eviction — activate deletes every cache
::  whose key is not V.
::
++  sw-js
  ^-  @t
  ::  The cache key is DERIVED from the two files it caches, never typed by
  ::  hand. It was a literal through v6 and v7, and both times a deploy that
  ::  changed the client shipped under the key already in everyone's cache:
  ::  the ship served the new code and clients kept the old, which reads as
  ::  "the deploy did nothing" and cost a release each time to work out.
  ::  A mug of the shell and the client changes exactly when they do, so the
  ::  old cache is dropped on activate by construction and there is no
  ::  bump to forget.
  ::
  ::  That same property is why a SHELL hit is served from cache and NOTHING
  ::  else happens. There used to be a background revalidation five seconds
  ::  after every hit, which could not find staleness it was possible to have
  ::  — under a given V those two files are that V by definition — but did
  ::  put one fetch per SHELL entry on the wire, all at the same 5s mark.
  ::  A ship runs its events one at a time, so that pile-up is what anything
  ::  NOT in SHELL then had to queue behind: /apps/lattice took 2.0s on its
  ::  own and 5.3s alongside the revalidations, and clicking home out of the
  ::  editor took about eight seconds. Freshness is the cache key's job.
  ::  the mug must cover EVERY asset SHELL caches, not just the two big
  ::  ones. With the 5s revalidation gone (#154), activate-time eviction is
  ::  the ONLY refresh path — an asset outside the key that changes while
  ::  the key holds still is stale forever. All seven are compile-time
  ::  constants, so this is exactly "the cache key changes when and only
  ::  when what it caches changes".
  ::
  ::  'lattice-pages' is the OTHER cache this worker consults: the LRU page
  ::  cache, written by +page-cache-script from PAGE context — this worker
  ::  must never fetch (webkitgtk drops cookies on SW-issued fetches). A
  ::  navigation it holds is served from cache; a miss is REDIRECTED to the
  ::  same URL plus a unique ?u= marker, which this worker ignores, so the
  ::  network request is the browser's own, cookies and all. The ?u= guard
  ::  also keeps command 303s (send-see-other's buster) network-fresh, and
  ::  activate-time eviction spares this cache: its freshness is rev-based.
  =/  ver=@t
    (scot %ux (mug [uih uij vjs icon pjs manifest-json icon-192-b64 icon-512-b64]))
  ::  PV versions the RENDERED reader documents (their inline css + scripts).
  ::  V only covers shell assets, so a deploy that restyled the reader left
  ::  every cached page serving the old markup indefinitely: content revs
  ::  converge quietly, but a CODE deploy bumped nothing — the activate
  ::  handler below wipes 'lattice-pages' when PV moves.
  =/  pv=@t
    (scot %ux (mug [web-css nav-script page-cache-script sse-script page-sse-script]))
  %+  rap  3
  :~  'var V="lattice-'
      ver
      '";var PV="'
      pv
      '";var SHELL=["/apps/lattice/app","/apps/lattice/app/app.js","/apps/lattice/app/vault.js","/apps/lattice/prism.js","/apps/lattice/icon.svg","/apps/lattice/manifest.webmanifest","/apps/lattice/icon-192.png","/apps/lattice/icon-512.png"];self.addEventListener("install",function(e){e.waitUntil(caches.open(V).then(function(c){return Promise.all(SHELL.map(function(u){return c.add(u).catch(function(){})}))}).catch(function(){}));self.skipWaiting()});self.addEventListener("activate",function(e){e.waitUntil(caches.keys().then(function(ks){return Promise.all(ks.filter(function(k){return k!==V&&k!=="lattice-pages"}).map(function(k){return caches.delete(k)}))}).then(function(){return caches.open("lattice-pages")}).then(function(c){return c.match("/__pv").then(function(r){return r?r.text():""})}).then(function(t){if(t===PV)return;return caches.delete("lattice-pages").then(function(){return caches.open("lattice-pages")}).then(function(c2){return c2.put("/__pv",new Response(PV))})}).then(function(){return self.clients.claim()}))});self.addEventListener("fetch",function(e){var q=e.request;var u=new URL(q.url);if(q.method!=="GET"||u.origin!==self.location.origin||u.pathname.indexOf("/apps/lattice")!==0){return}if(SHELL.indexOf(u.pathname)>=0){e.respondWith(caches.open(V).then(function(c){return c.match(u.pathname).then(function(hit){var rv=function(){return fetch(q).then(function(r){if(r&&r.ok){c.put(u.pathname,r.clone())}return r})};if(!hit){return rv().catch(function(){return new Response("offline",{status:503})})}return hit})}).catch(function(){return fetch(q)}));return}if(q.mode==="navigate"&&(q.cache==="default"||q.cache==="force-cache")&&!u.searchParams.has("u")&&u.pathname!=="/apps/lattice/clip"&&u.pathname!=="/apps/lattice/share"){var ru=q.url+(q.url.indexOf("?")<0?"?":"&")+"u=sw"+Date.now();e.respondWith(caches.open("lattice-pages").then(function(c){return c.match(q.url)}).then(function(hit){return hit||Response.redirect(ru,303)}).catch(function(){return Response.redirect(ru,303)}));return}});self.addEventListener("message",function(e){if(e.data==="skipWaiting")self.skipWaiting()});'
  ==
++  icon-192-b64
  ^-  @t
  'iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAIAAADdvvtQAAAABmJLR0QA/wD/AP+gvaeTAAAgAElEQVR4nO2dCXRdxZmg731PuyVZu2y8gOVF3i2CbREwDtiGhoChe5ptmiVOIKHTwDAzfTI9p3FP4JyYOSdzmOmkSfcQlk7AodMd0wGTBKaxnQPGEMs7IMuLLCxvsmUttoVkWdud897davmr6q+698nQx3+I9V7tt+p7//9X3bp17bzCWttyxf/rfrCJ/5NR3scwxBZG0SWEwWyCoCQyQpyMDeHaz4i4VFWoShxEGJTGD6fj0t+oIAf8nM4JR4WfqURcAr9yukoqyg0JS/A+UYkdy8oS0BOMEkwVEMuBFf4JwYiODpIbHjjh9whiQ2EMFWQaMiq4mGDEgh4ORsvN6zCf3S4lCIGSeYncFEyCdGyqYW7jbL++4FuQPjUu6dj0+KYKs8lybMvKMqWHVzxsOSjFg0EHVjk2GhoMMfFpIIu5IEcFU0iSH+R2WqAP8BiRZbrkkCmosfeqTcfaXiv9WI8oL33wPTXmHENZMdEDmS254qFTSNJgucFCA7TYVOzgE4mJKI0ApnDU/SAHUkhCjJxATaBUERfrqyKHjEUzlMXTQ4+TFj1ysyWyWWbo8NyIkKDLEqfRFwfK732E/A8IJiFJnEISIOIZHs/E8GkCVaQ2Z3KGvApohrIU9HCIyOkRmy0yn1ozqdFRcCOBRmTpDMT2/kKeL3k9MphYkiJglLJXpP/kaJgzEUNe2V6IzTGUhadH6TIjzBaoeJDoYFQO41GJMorT6IkD5XbHnUrDwcST5NoaXiHhMfJtDaWKkOZM4laHUSBDaQ0EmhsRPQLbpDBbcsXD1iVHB8MNpLmA2iOKDQUShiL4RMyBbZgkWiFxfHAYkckkqkhpzni3mnZ6IIaCcizHyaKGWEGPxOmRmy2s4oHREaocJDcYYqJpIFlRJE82liTYrpEYkZpCSxWF5sybn3t5Ay1FTs1ghgifOuUD2VHo8XoB0A1B/xBuExTLfOcSwHltBTcSIEZFA8FpHAlJtJ8E2jUII8qisaqInqCxJROIicyZkqG0CYtEj8xs4RUPFh0jbjCWTGLyICGGn6MG0kBsFEASb8OUGIWjK1BFHprhGiA3/1K7RAqGgpVogWGKgR5jxSNFR5+bsD3RdRDXQtv9k1b+Ap4wJDEKicOI0iXE1BqjimTmTIch4oO7Eu1TAmuFuOhhFU9m0LFNiYnJB7LpTqR4om0ZVW8Qr8IonFeLLJpQFcXGELU+5C0kxkcPPNuSKx4MOhK7JuAGnNEDeaOIDQUy2sf/f3qAwmkUlZhRSIxdQ2IkV0X87CwehhLMpWaaHtsrF4wNA23K9SZzkMmor+6nlO4jc1PJmLwZEhuuK92qlFARgsvx/tqqTrOEnQaNHT1EaLsRjh0R7n9MmzAbLA5Jj7HZwikeldYR65sorNg683aJQGbL5nUSqUuIr95f0vexdVQRY86C4ni3GqOHgraResh214FIism/kelRmy1ddJhQ3r/Bc2NAmCSLg85Lk5SmiHaS+ClYsDYTUhOmoW9aIc0Z5xIpGUql5+91ZEHjlwl6aAgA9auJDmCklJJR+2WjeaJBCS7GGzZGIeEwAm5agZP8aAwFGQmNlAho4MxnPPT49juIQtLDmHwilHVx5J7NaHo/uvUy7pDnIUGxto5GD3+03JhGUQrUmAbpPQ0kqCkGeiRqiaZVoXg4rSMHQgMX4XQNIQ7KKeKMlyTW5rUR6RuBqghpziLqIf6+fUrIlegM04NVPFHQsSPjgqHJkZTmOBFJ4jESWDRqRVhuzjLEUHolOsSCG8JRoUd2FxaNjgoKON5Y84AZHb4uMUwSkpAYsaqInqAJ9mBEYsiCCrf9WxmQjeRH1GTBAGW2WEpsmVHju1sQx0ZGsFVqsemv6VGykSSpMKJmarAqEpgzcHu8kqGgDRBSIUOpfxIiXIQrTpHoSTnAXlTwkUpP2E0FPUL/lF5K/EI40Ta4uskmBsODeHpllUyQjiU6X/j7RC8Rs+WHGamG2f4sjGo8ZYTipoe/MPYa0q1lkcJ0t4CbL4LYOJJUF0vNP7kuosYtEwwx6b3UCbog3VIi0iNRPNroxMGNjf4vYvmWIUZKVRQPQxjd4VVCmrCgDOYCpHosBnqC4tlAoAcV6OAlIhaxZLf0MXL/kgY+EwyBvimzwcuLDRYSabK4r8b0YJaziA6RdlxUdDLtD9ma5WMwgrOku1VzCVeXIapw4deESn2532CdhKEnLEGoMPUUjz46F9eJjoiRUhXRIcEQhH1kwJBXOFAp58YkoLFEGT+KFCU9VF8QUwYhPdHR+YL40bZOa/EYkQzB3YtjCAzX4MHTQLQm0KLHRtPDNF1itqKgY8wN3oOOWH4UjIDE0m1YSoZsTYa8TMF3eksrnV8yeYtCDw2rWD+HrRWlVGREJja9F5bKRq8QIncL2bjb9dzCnhfFBHkreqn/ibdhuIMi2pbKrVOHJVO3TPjlRP+pDE6lUVcCsEXQY8VHjwgdJRxIBPwWxmfWbKoomxhvJw6M0o/lsJjyGVFbeQQMBdfB3fMCvhLV+QUkEKaODGQuIwCGYyI2enR2RIjTuFslpMvBMYjtV+HvXEW1TRmLM2deC2ypLUMMHFu+nBByGk/GMeVRRoozqOFXO356RILyJwJuRl9sDZKUGMXGEK0GqOFTbcqAKw0ebZav+nDlUDX5DafabUgPDh25iHpcnUtHkB6P15L0dlCU6yOKok6TCsN1bBm0pTAMI/JDzhDzdJhXDLsSHV4xe2EMvwwNuhsamcLjogevcmKcVdmYEmiFJC9WFqXaYiDRQ4wWUI0jDowE2ngx2g/Ua8gtaWb0KPQ8syFUWkiGTJqNJsnYsYvCkK1nSXCGjPWBJMbL1HbGRY8xOpm+g2FSIw6jTDMED2iYGDAmbEXUrQyV8SIr49KABMRAj+zniEPn4oodASNRlB5DQDigFAQmhS+ZniFlaRovFlJI3UGACy6VX+mZXt138/yOKy/vqSwaKC8c7Pw8u/1s7q4jRe98UtF8qoAqX4GOloTp83OGr5/ZuWxW56Sy/uqxFyzLOnkm70hX3u/3lb+3r+z8QNLAj7a88uH0/hNXYQKiEy7QnVDudwK4SgT71MFRLOCWQt+hZt3tYO2IWUVkfG67sOSqQP0QoFBqzUYZL44eG0mP92dpbfeTK1sWTP5cNAi7jxSteatm8/4y6dY+pAApS/IHH7+p9ZtLjuXnDIN5zg8kX9o88SfvXn7mfDYU76Brh1M6jrW0tivdCT3STpiyeX8pWZR0Qdzbce/PoYJYN8D9PxBIhFOB/hO1XpRdWLJQbCwDLmxT1wdFT2He8I/v3/f1+R0WQn63p/KJ12Z+3k8+EskWLhZhmpvmdvzo/r0l+YPKIrr7sp9YO/vdxgpxEgxJbJrCvKEf37fvlvmnEXmt3+6pfOIXtZ/3J3UYYg6uDx7lkDDkZ/FxCavzA5M5eZcR/EhcLdZ2+gDYBvSQcE4o7X/98Y+/Ou0spuNS6n1c341zOt9tLO8JGYp0h9W2re8uO/K//2NTfjaseBjJzx65/cr2voHkjtaxBtWBbZ5Q2r/usd1fnXYG0wDLsma4nfBpWboT+IpAv0fkUIuzME4NM8ppSQPEF60wXsyqD228YMeZpyf1tzBveN1jH8+6rNfSkcqiwRtmdb2+fdzAUFJrnMgGBP/dvbjtf961X2vhMWFb18/sOnk275NjRfrbnNkEhXlDv3p0t1EndK/bVj0wlED41G6YkBLOzgQpgECytBRAIvVjZLyET+pwV5H68/yqJrzuIaW8cHBKVf9bu6q0dAA/2HWTz7300CfJBN59CeX6mV2bmipOncsVFS5vTCDPf2MvXveQUl44WFPZv35XJaX3qXrZz7h7DFQAXSqrhBLAFROaBmq2VK3p0LO0tvsWnN8Dym0L2q+d3g01T81NkPKpPzmYkxwxa0BO1shTf3yQr1FFEiVLa7tuxvk9oNxWd3rJdBc+HEPiuTYbyBYCK6H03Xg2J8Mjo37gmojmC39qzLTryZUtVjRZffshpga+RmbHBakPVszpWDzF5KcfyNVTu5fN7hAtHmL2hT25krkEbVl9R9CNIENc1fALbnQH3Ysmb2VYpjAi1BVHz/TqPsmMHSl1k89NrerziwXUAN0StoV/uvBkxAZYlnUXUIgSIy/B9Oq++ZOEM3ak1E3umVp9niiZv3BehIZMOOKCwsjXPYEkUkXbEYwXE3JzBONFyr1Xn1y7ZYKgEplkJ50Vs81tRyDL53RMreobHMbVSvta99a3RW9AqjPndfzk1CTFrkXyM3lUOHVqAvEPfU8+vFEfrjqmFxKLShfResX9P6Np+ECbno/bCNeHCnnpob23Lohh/C6JZVm/2V358Muz6a6gjkRwQ9jPXhLJ0iK4VkQtFIUHTAX/gk61QIkpnB4vERRfXZy6S3BJYhH3lgsjuL0JvCETRAk8oYQsM1Ay6Duz+SWuTyBlY9RrvpcEKWUFfGfKnSHXm2ZGRe3D8CUldNQP5DujFuAAZ6izF7yddElMpKsvW+5xCoX3PVhcFEqIPCeajgMVG51ZkIRXP4C0n/XW3y5JdGnrzhNFKZSQ3LYglBB1J0VH/ZCt0zNebsiuI0W31sXgRD+34Yq1H9GzMKgxvGQnR97+y4bC3KGIDejpz7rl2fqhEfnPHV7pfuCa448uPxyxAalb9EeLJPMv+vkyfkbGPX5GHEDGP9ZD18G8M1WmtdhkuGmrUK++80nF6tujLiRalvXLrZcd6czHVU1H2/amporb66IuBW3cW/lZxxh+zsMJkOCft14WC0DvfFKBm8PDAk3RwZwAVQnCo6JTyiZfePUjlOZTBbuPuL8bc9nZOrbldLDLjGyGsHp3F6O7GLtu2/iIDbAsa9328Uyxopr5VjW3F+w+UhyxATtbi1vawZ8QUbfCmxbYHrlLk/4DHnHHl2PHq35cWbO+xooma96ahqjUj+AGeOPeyoaWkigN+Ki59PdN1MYgBEaUPPMb/hL05AdvMt1o4k1rDjTpRLNJqG0bsaofNnTzgbLf7q60TGV4xE6Qb2IXKx7JoH7/jZnudggDuTCU+P4bM3VrZNo5OJQYQq5iQ/LmruoPm0uhKvgmxaKEWI8mmZs/Ubxzww/XXHrm152hq0r18Mam8hVzOiqLTNaEEra1sq59x+GxR7vyDdBx5dS53OPdebfMbzdowF/9yxxG/ejUngqvrzmz9pFdedmG2wEajxeuemHe0Aj/eDFcnU4KoVFiEidz8ycp7l3wew5NJl+QErOtweHEhsby62q7zRjKTjpphkrSDEEVKCSlDPaeKO7pz75uRmewM0EpwyP202/OfGXLJLm/JW9Gfc3ZtY/sGpOL2gbJS+Pxwgeen9fdlyOqFmqJKAE/0EQwm4niIaWBEOqHDoxJ/bjS05/1+vZxUyrP145DbckbGrYTCZ4hVw+FpSP82TDBztaSPceKr5/ZKdpOT0pXb84jP6/71+2prcCiAtn6uPakdc9Ohp60UbYwsn5X9TdfnNfVmyPtc7YVlkkKVn0wEUKAoFunfjirY7TVD9Obg8PJt3ZX/eFQyYxxfeOg2zqu7Gwd+/gv5v7z1stW1p3KyXJEDOlOhVz57PSY1z6a6FjW3Ik92Ul43ts3kPy/v5/y3VcW7G8r1C3fIhoG0nN+IHnf83W/2jZ+xrheaScUP7Z29j9smjw4TLluyo1HUDIbiYusQ4vKrgZvs4P2K3b1wyeYWtV3T33b4ytayejnNl7+yz9MCGbsruvAD8CDL9R92FwuulILJ3nZw0tndD25cv+06lAjNp8as+at2vcPlPUPks+FyQWmcPGUbpCeB19YsOVgGdEJxx9bTnXC3224/JdbL6Nn7PSjGNTDN6I2MCtW8lv0XojosQ3HckQqkydR5gx6nwSOLPtdTI9lWYfaC15l9vdY1qtbJpLrPVtbSu5//iu9F6ixzM8ZfuXbu6+d3oVpA5TA+69/MOvfGqt2tlLT+52tJf/WWNU/6C7c48/+YaW+RkRPXUCP3wkTmbyvbpnArffYGVBCGgBAOxKlpSo3rcZhiTGqwhYx9POHd9EMYY4xEJt+RaNsXPme1Nd0v/odCT2oC89kAtLmYLMR+4F46yP7xlUQh/rBiZcFwZCGM0Q+6ANeizSBrRwYFT3UpelIdCWkysB/J9ziRFz2S5oMn16vB6UM8Q9sBFVQZtfsCDMooy1qf33NGQQ92JozPwoaGCRitV+KklTjZKLDGz4rvf+nV0EM7YT8IRYdnZYIdKyt8CpEuucbL14JufxRDRlSCcVlxcSr+DHYL0wDtErjiUyFNLSUIBgK1YPq8T+MzwT8NmwCziCBT88QT4+re6BFByGpaFEnjWbFQknwVo37F1mLrhmImJ3qehVDEnTiPDjcpjFS0sNfiE7tkq/xZofA8IFJaKo1Y/uF7SVNs2JxDGVBDHUK/HeDkQMbZlPf09/E9HwF4fdEUkLQapyZFVPnYgHyf6oalZv8fqL+YmDN39BSev9PvwIytCTNUNzoWKIyr57a/ep3dojpQV2OpScGKlynOJcrLpnhTgZdwJHus3gXLLa7RQz97OGd107rRE9SRE40aoJTX9P9yrcl9FAN1rz1y3ha4qQIL0j6FSsJlQOka7kwjYv910+JlCFwnTpoFf5seWGy+pozCHoyJPF2uwqJNDY4DSRWDEb2S1A61sCrtX1DSxnoD/3s4R2+HmKyGzvRlKR1z3YBPeoZO9JPRCohzaKoYHzZ9B1dKyOiCVl0258KaWgpfeAFJUPRnSGbnLGD9KwK6RlVRyeO37a6BZAGUnvQWqoyzuvAz3htW8lQjA2zZfQ0l+PH0mhKLysvwlfl90hOtLHYUdxnVWmsp5lmaCHSlnHv2qEjxe/7qa/pEtBz1RZ/rVn+lJyOyF3pzPqXvCTQHnSGHCANQc5TmBAxQ9sDhnwssCvRJEb1Cnq0iYlbCSlEet9C7UcjNFC0y8lkbwgunft1yhki0NGqOjXQGN2DmCVkqo+idj4ie+wmzMToxgSZrBQJQ9fQc/vywgv3LD62aAoVuGhK192LjpWNGSAD64V+D0mPdlORgrZimbVxWfKC9T3oKOIVlZPFPuaSnRyJPsVtaCl74IVFr357GznkKYYe2rbqpUUfNpcvmHj2e1/fv2R6B39o65SKvmfv3TM8Ym8+WPG/3q79+OjY+pqunz+8DaJnYZoe+Pli6DWo4FXYUCfQz7THI4I3jklroh6vLy6/xvPLvNk/ZeQIhy0YD2KIQv+JLJz6Kt3qwHrQK+Z03LmwbfnsDmbzw+f9WZv2VazbNn7j3kq0MoMTLK7pZhiyLKt/ILm9tfTaaR0YSh3H2nywcuEV3QU5Inq8hEy+ILs8wYo5p++8qm1ZqhOo8j/vz9rYVLFu27iNeyu40+mFW6ERG6VFu6QxW6SdLwpACyb1PP0fDijPTG1oKXnqjZl7jhaDRUlX2MIQkKGIcp6lB97Q7v0J3kVBxy6YdO7pP9m3SNUJW1tKnvr1jD1Hi74IACVzCyaZAYR5goezO/Co31vf9tK3Pp5cHhw1KpQJpf13LTrRdja38Xix8eT2xJn8hs/KbltwkjcT5vS8tOjDQ+VRjPs9i0+8+K3dmE6YWNp/9+K2E2fy9p5Qn06B0alRfNBkbsFkohDRU2BkDXEB5H3+7rIjz9y5H39WfDLh3DzvdE9/NvHgBNZ+Bb+J490phlbWtYkeAcNLv0tPesZuvOb+5zccfubOJu1OOJ+94/DYjM3jMDP5zC4kqt3tm+aeXn17s0HRf3P7/uX0Ib26a2sNLWU7WmO4u9lwuAz9MBo867xpTvuTKw8YVP03dxxc4R1zjqo3A6K8mWr6k8JISf7gj+5vok/YwEoy4fztn306FvF2JlJIp23+pLNLpsVwRNqS6R1zJ5wLa9AcrJL8wf9z36fGnfCj+/eOLdB15uwY00bUQJHQfvymVsz7uURSNmbgL5Z/Zpz9e7fovaFHJAnb+W9f32+c/bEVLdE6YTDyGWeRemH074V5UpAz/M0lxyIW8q3rjqiOQ4B7p7zwwnXT4zkq37KspTNOl9JrjMoGuFKQM7xqydGItT+0VPiKxVEQXYBis6Zfwx2FIZeCnOGlMzp1WujFrph92uwVT6AkE86K2e1aDXDla7UxdUKtZKOcldEh5l8cOUpywyx+Y5eJ/PdbDyyjvGkb4wBdPTWe2gP5i2XNV10RPMooP3IzjKuvET39qCc3zOz8f+E5m6MqFw2gyWX9sZQzY1zvDNzBQhmVaVW906ouWjMuL4+nM79MPhD4eodL8qXrzIsGkP+m9EsSg8TmzX2JAGo/Jzrc75Joy6mL996Ii+YDtcLHy2vLgVNjGlpKDZzoqZVxuiyH2sf8oaVc14leXNM9gzgHzVhaO4Xvyvh3C9CmpvIHrz0evZw1b9VuaKzSvTd396Jjz967x4pPnts4bd32iQJ8gK9ukj+ae+rlh3ZFr31TaoPHl8OExWZt399fdn4Af94gLL0Xsj44UKbTQi92w96qYcXrUTRkaNje2FSl1QBX3j9QHkcnJDcf4M8aNxbny+EDnR9IvrSZPQZQV17ePFl16iXcHV29OZsPxvarff9AZbd/4i6yAa6cH0i+/IG7G8JcXn5/ks7RnzErhYgARar7uQ1XdKfelGYoXb05f79pinH2H/5u5kgcM8ERx/7h27XG2X+yYUqUTujszXlu4+XWxZNErITopT7bl/WfXp1tZkqGR+zH1847d17PhyO3531yrPiDAzEoofcPVBC72xCvfaLl7PnsJ34xz7wTXp2t2wl6w+R8sTeUtZwu6BtIXj9T+1bO02/O/NcdlxlvKHOf53p02aHsyJsSx429sONw6dEu/q1TmG3RKfns9JjeVCdo3115+o0Zr28fh683A/IF2NK6o3Xskc78ZbM7s3B3Ny8MJf7rP835xUeT+KKQe8rSz3N1889UmElW0rltQduO1tKjXfma6idM7b7u44ZZHfhO+C+vzSJe1ZgJRBzEv5Y5QMzKCh/rJaHHDky890TRpr0V06v7JqpukH3UXPrIz+re218RZVM9+DRgFMl2GWL1kN6gpjqhqWJadS+mE77zj/Pe21+O4TWuNCL5ojyV4f5dNrvjroUnl8/uKMxjn2jZsLdy3fbxxOuVlLtF4QQgPf0Dya2flV03owOzM3DEsd/bX1lf05Whx3qWzU4/2zTrNNAJjRXrto/b1PRFfqyHf2HPKALk/plS0bdl9YdkuiVrrvmsg3+/ibYSEj6JnN4VP3fCue/dsv9rtcKtQsMjKXR++HZt4/HixTVdr2g8WKh+podJfUV575bVW8iQJWuuId73cJEA8ksLAAodePc9qvxF24owMJ+ZeEXxb0AeHE44joPZb+yk30IMNkxOj2VZnx4v/saLi0rHDKyY3f748oNTKvuCZC0dBX/37vSNTVXBek9DS9mDLy5iGHKflYYebYbdZ/FVOFAn2BnweBQcgzU5mVxIdAy+RrHB4sIt3HPsCz9sptayu3tzfrVt4rbDVOD2z8rWbZ/IrBY2pJ63X4Q+Bw3bVKRg1A/ia1RBABStxpjggMtW1ego6dnS7LqijuZ1ptI7DpIh5e8kU30UtfMR2ROBVUNO2+Jsn6YYvZvdkdPjlxz4CnKSvAR++pSoGBI6QyLRXouMJoLacEg4F+FemNyK6fYdPDxBp2idwOJikf6Px8hJS4AaJQ2Ic9DEF2hyyWj7lXGBAHKULbpoRhf/63Qc4XnNPj1xuqINQoZS51PjdUrc6ifSSGE86sQo0Gu8PmuaPhWioidIGd1NcNxPMoa8c/LjUT/YpJkZTqZUnAkT25c4Wqk9xRWVEEh9TRf4pgHB2WFmGAG5RAwF7+uQNxupfsT2K1YHCFd2glwd0vKg5Q3T+RqziN5ykj5xV3KagtKDRiVraCkBzxYWvL8sXom329UetGU5xk60XuNUPy09V1qihKT0uLoHiQg+nJRUAtH51DRDBupH7j4zpakKi+lXzQIEjqC8bCMrFtX2gwxJ3rD0AfWmgeiuD9hCJ/iy9ZD7HkURQ6jL0W+AZgZpDtCD5nNgNJCbVdeW8dNgXDZhMkX+ND2it5yUQyXHhZHDlONWJHn3FMKWCXwTjT40VjB6w+0CJHeDpDWZNDGW7BSS4veSuu/ICU2kACNjJ9qhm0SZGDFD1LvJjabuo9n5QgdIqoHit2LYi8QrIbfrVfQEeSUYkUBI2ilM49DokHN7OUN446WDmZMJ+wUKAJB4+CJaMawrrZVm8RQMPUB2AUaSlgjH1aHVEJPAZwh4N/k1wD1Xk05g2mNUJpFSeneDEVAD4W2ZriJVptdTxfU1Z9Y+Ar9Re8tB0aNSlP4Q3Z1QCpTREbVf9E7gV769W39u72R+FDQwSIRxvOcVgxVTKiFz8y+lx9U9SmNENYz8D8ggS+Co6kIyFNUZQqqfaPaL8phhHyiCFdPF3yBBKg2CnqA0jE+jaoXw5+HgMVUxFNV4RU6gbb9Sm+pz8idCm1nxW6SVm1yV+1ypBNOr++675sTimrNk9MBgou1Mflev9wBemp5dPD0PvlCHPnFXKPk5wzfOPn3P4mOlY8KzL/OyR9rO5h0/kzcUbgtUCtDnx7vzth4qXVl3KicrjM1OOivr2nccHnu0yztwYnp175999TjTCReGEm1n8oJOiEn9RLJfqU2fRWVXe0+Euf/6BIBbpIknxSS7pJUbpeHHfZbWdj258tD8ST2CS7L2HC1+5jfTBgYTInpc3SPd+Sob/pL8wcdWtKxaclR0bqH7JPLfb5hy5rz8WVJHGOFNG2H1+eALC5IJ669vOyjthKI1b03dvB+w0YgJnSMGyFU/4WZnxlqF4YT9kgFEP2qYWSVUmDf04/v23TIfdWrz8IjNbHon6QFKBwSIvXFO+9/e9ynmxN3uvuz//Nq8DY3Ba1/w86MwFmSIvzSR/G5P1ROv1TY2ZdYAAA6jSURBVH7eT2xp511YyN0Wqx/PfnkchSEBcjBAydz8iZy+oZUQbcWI4ZEApFZCQTETSvvXPbb7q9MUbxgJJEGXxNPDViATL8Gf33D42Xsb87NRB6bmZ4/cXneydyC543DwrgXV+gSnG4535zW0sLaMuTSJTB/Xe+Oczncby3vSDEH0AK1QFit2BgEr5n5J5uZPCJWNTAmFBitGJVSYN/SrR3fPuszwkCVX7afpgfse8yDH3YuPP3Nnk9ah4wnbun5m58mzeZ8cU7/uRLTQfLw7l2cIL5VFgzfM6np9+7iBIclaDNMSUQLSfSbCCc1DhFBIuRpI+lxYJpXQT1ftxeseRoZH7PueJ3WPEAEJRnWTz734rT1mZ0ZfP7Pz9/sqTp0THi8nvUfhBHrorkVteN1DSnnh4JSq/vU7qzKgfhTTbYfeVE9HsZTBxpSLCD8jZ4JLa7tuxvk9oHCjLpxRe/uZIXnqj/flJA3PV8jJGvn+Hft1a2TamZs9EuXI89sWtC8BliKN1Q+YhPd+whj/ZqqoVqYI/1/cFSsmBU+ubLGiyZMrm7VmQMygrphzWvl2N7lcPbV7Gf2+HCk6QPP++raDURpgWdbqO5huVM7FrMgDHSZI4ExdXEoolOnVfQsmCyerSKmbfG5qVfj8KNEMBUbuGP/pwraIDbAs6850IWSxopr5Vk2v7pXM2JFSN7lnarXiNXUxqR86Mv0nmAe6DwKT/1IRfDLcI818Ki/k5vnxvOvknvoTaz8MTjlhRNbA7OTI8lkxtGH57NM1lZ8PDst3VsFg3VN/InoDUp05r+MnpybFqn7AnMCMzC4qXSxeP1QuKmKmY7D7/NJDjbcuiOF1XZfEsqzf7K58+OU5Inpwaz+Ar0MtKvKB6W8JDZXFJOAnfHxZYvqriy+96mA0XnWgoAepfsQuDetEK7QW3xrUTgjgl1FG3Gm6JBGlrGDQzHgJ1n4AU0WXyDjRGkoI4pRBmUkAxKakk7opeEkiSRdwzivGeGFsi2JGRewHAjPTUWwzIEh5AZVU+8V7vcO/P2nrzlPRAwqofgRRsBIhDpjyAm16tuUE3nQQyc7U0lMy91wncs5FT+VS8VTIriNFt9bF4EQ/t+EKdhaGW9XNTjpv/2VDYeSTEnv6s255djF/HhQs9KA+cM2xR1e0RmyAZVm7jxbqbNxjfGdz9RNM49k5PDeP96K847+8aDo9FRjm5C7DC3nnk/LVt0ddSLQs65+2jm/tzIV2jLABfN6NeyvuuPJkxAZsbKwgTp4jhR4IQB84v9w6PhaA3qFeVyh3hhjjxcyziH/UPgzjA7F1geZJ7E3DhkzoDDWfKth9RH0nUi47W4tb2t1NWPInbIAElmWt2wYesqwn64CTmoFt12CC5vaC3UeCQ8oNZWdrkd8JSteHCZT4zoKUXGHBbRiJJ0TdBJF60wqXiGFozXrzFxW48oP1U5ka+BohjLzx27i3YmtLsCXDRD5qLk2fmcqWLKgdaOSat5hL0JYfvFmDdn3wxks56F50QrCMjYeRrp6pkSuEZGjzgdLf7ga3ZaHkzV3VHzXzj14IH9oC1cD3fz1DsB1CLReGEv/j1zNEyk/86BklH6Q6IXjTj7a8uavqw+YSMT0axosNZAth52zpMCeZk3cZsd1BtLFVsM2D2ypE752Al6fJFeqNe8tunNtZWaS9JtR4vHDVC/NUNxCEHnXQxlPnco915SE3QzLyV/8ya1NTefSHsjc2la2Y02HUCWO+8dO56U7A0RNSABgvge9sydVVGiB2f0+wvYy+j0EEyrYKwfc3QIbsweHEu5+WXVd7Rqv7Go8XPvD8vO6+4MxU7M5DUJrainrOZ19X24XflDM8Yj/9xoyfb5kQ+VHJVILB4cSGxvLrars1O2HM/c/P6/aX01DPS7GJGBpA31mmfkKAACVE7Szk74XBd83wDAUA9vRnrdtWXVN5vnY8f18dkPW7qr754rwu4P1cmPGH0+w4PHbP0aLrZ3Xl56j3BnX25nznH+dBvjOeGzZNT3/W69vHTak8X4t7hfn6nVWrXpzrP6EBjC3wlb/nBRgvHXclLXZhyVUBLgQrGEMG3mQlsqj2JTK3WpdMP7P6jpY68R6Pna3Fa9bXbDlYKt5giN/YB6QcWzD06PLDDy09ViB4KqNvIPnSe5Oe23i54A1LDrp2OKXjWEumd6k6oSjdCSXoaVfg+jDGi79pyvvOpPoJ05ATJhIg2loRNotSQmpDZsBQGDi1+vzN8zqunNxTVXyhomiwoyen/VzOriPFb39cQUxWCR0XlSQ2fV728NLarmWzOieX948vSb33pO1M3pHOvE1N5e/vL6PfDeho1oKdn/qdcK6qeKCiaKCjJ7v9XO6uI0V0J/h5zOgJSAjDA5C8r7TXTaqfMNAFKLRZaEPGMAQ/LCZwqIU+NduvwkA/n4ITXYwyJ44sjnNhEXmVXjNJGEgPgQgdGDaK0DRhpXRggkeSawFzfYJVRNhnpxstuFTpyXaS7YWqPYCyvKMmjlzxQGdSK/Nq0AOPKQEKUyqTGSiZxjG4mRrkkJSLsZQiWqMwpPiB4jAaTZgcZY0qdBRdgacHQEHP9aHr5Soi11Fok8dWSRpLokC6vRlmKApGZCEZIsnBFI5DZxTokZsUZmyZbGEGckMZcYlAg4LsnDai8oDYxsWQPCrESIek6EfcOWhulOiofz+m9AQf0eOIAyN4LszRX69kWRHUrc2Q71SaqSIvgf6xUY7mf+hy1VdENkAUJbobg6QH1AJKS0KmAIpynwuDGiE0ZFxZFFSg667NEFoVYTAyICkecSiVY4yOyGzp08NO2nV9WbjS9N14eJoH3bMNg4QMBZcRH0NRMGJJyihMDvu+H1TblLGjQA+pfZjy5YSkz3aAt4MFX4NAZscZkZgqwt/FyG5TDLaeBa+l5KujFm/cZpN72ATCZpQmc4sFFzO1xeFUPT4rJgECHSw9bDjdcsDgAF/JMr3QLAklJAs8KwRDwUcsQ5aTTgCTwYYQ+yCtODAiE5Odp8uRsSpDoaNHD7E2LKKHczxCPkJ6uN8DZ7xYe5cQ084YMiI/VTIQTrUF1H7UJQNvd2M7KTQ9SH/CYHQz5UT7ouEMYXaihaXFTE84XpDxojOR03i5qWOKZunEMkR9SF+4o+gdQ4yikBSvODqtxe9EI80W3L0IeixNegAeElJ9FUTCVjDkAMMQWzLTSpF+jojRxSLJ0WyexiZGmh46JBiCcOVAQo/Ph86gMzWS03jQ1nCV6TMkwDxMF/6K5P0VCSNyUDMEk6NZvhwd6S8qPdET0hMOgAE90ICKv7Ir0bRKoJplzJDY0NLXo6mKTDEi0xu7NbFkt6ToyBUP31ex0iPQSQ5mJZpgiG2cCnljhoh6FaoIg5GxgsmcB+2KEwEdv0spxZMJeoiECFc4eOWlZVRKdIbY1nOqSA+jmEiKVxyGGxN0fMUD9X+89CB1h5caPOJOpMdiYSi4AKQq4hQp37MokkYZJgfNjeRaSF0jVTz+Pdp0r2WCHig8/W/qhFliPQ9aTgy/Btkdx9sMSCcI1xgdfwej2wLbXT4Mlhn95d9gxTGMdYvysgUJqQR8F8NrgEGX+2vNTib3KzqSBmjlYsMpz4MZQrHiQal/pgimMRx2bOGpf4iV6HAsw/7mbjsEJywoGSLvdfCFB+W6zWNj0/8Ga9ZIjNQk0TcuwMHD3g8RRjuqAhSFKNEB+IiVHkdrQ2MyO7ca/YwOvVca2EPN7rondlLzG/Kp+qiP1CgSDaLuWslHWkO7xHcvTCny1Gh0WHroBBwiUeih3RXAV8lij26hVIXo9qepHgqjQHPGqyLKuELaSMSKQidRSTPuHTkasfCD61qKZ3To4Q6Y4moyqwaoiXarJT8R5jrpXMEn1h3F7Ii4yE60QOhYdlMu1AMosxVqpvjooTMR6ckH5Ai/hPOgo+ghX7MRbrL3jXSJLIEqIp1ri9VGoeHDqJzRdqIFwqsYldaRoWPp/CajKQWWnpQks3OqaL9E/qygvj+kdolYp4f4InKMuJyAIxOFD1HeKGrM4QIoW8AlwKGDMltx0CPYkpbMzq30xykYEtChljAU0kA5xXQUxJAII5ohxu2mhIuAXeJ4lQ1eHCiM4UaOjtJmUdklt05J0yaKkjokXDh3TjRRgbgFELxhNZh7NOxiF/wbotfNaC8ouBra5Kf/g9fsRtMTcuC63I2u7GMZgssJl1T1Oi1j9Lj/58tPaaAqcI5trodMzBnSojFGTaaQqCrVCshMRTmIeF7fiFUOlxxns4zNVkR6Un98EzYaDIFVZAIjOFCHJ1NxRMSIaIsRHVDxZJae1EJiVm4ltJoXL0MyVcQNqcTp4TASKR0+mSKUL0oqgPMhEgw3CHTglIBNgcxWfPRwJbsayIrEEHyMS6hsIqsiIMqIJGVULOKgooQIotDRUDziWJzPCocHUcns3Ap/SAwZ8iKAwTZQRXiMeIUkUiQYYjLjA/FpgLHkVY4BOgaKJwZ60vfCciqJ83mUDAltlsqcgTN82OmBMYJ9I7ZNULFQVAbFEYcpueGDxegI8PL/yNgSLxUKtuLD9KQ+pQHyh4DudTFDei6RiSpCYIQkCcwoTqMnDiKGTSPjBoWOmeLRcHrk9DCoJbNzPBOGYYg74FfuEumrIjVGSrsGlcJnl2Q1EEf4hQ4CgZNYKyQ6eMVDFigyWzKwCAUVmjD3oHUxQ+xwKBhSmzOhKtLHSE2SHCZlXnMfyFGkkascA3SYHBKzhaaHZZqlJ9BAFsMQa7A0GMKbM8bimGEkslASIISeVBRxwI+oVIA500ZHlQa+u65DD/WIHxGezM4p5/SNGUN4cybyiuROD5okDZi00uhpIBVaCG7ELhH1SeHxyBZyItLDmTA9htRuNUoVITGCFZLMBxLEx6t6eAEwgKOIQLHKQaKjVDxIl1mPnpQGysqp4EaCYoV1iThQUOZMqYr0MMKTxIUL+bHjUT8OLhnIjQw4XXRAf9nUZRbfWf//mLkTF5PGlVEAAAAASUVORK5CYII='
++  icon-512-b64
  ^-  @t
  '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'
++  apple-icon-b64
  ^-  @t
  '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'
::  +pwa-head: the <head> tags that make the app installable (manifest link,
::  theme-color, apple meta + icon). NOT added to render-bare (the preview
::  iframe is an inner document). +sw-register-script registers the worker.
::
++  pwa-head
  ^-  tape
  %-  trip
  '<link rel="manifest" href="/apps/lattice/manifest.webmanifest" crossorigin="use-credentials"><meta name="theme-color" media="(prefers-color-scheme: light)" content="#101541"><meta name="theme-color" media="(prefers-color-scheme: dark)" content="#1a1a1a"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="default"><meta name="apple-mobile-web-app-title" content="Lattice"><link rel="apple-touch-icon" href="/apps/lattice/apple-touch-icon.png"><link rel="icon" href="/apps/lattice/icon.svg" type="image/svg+xml">'
::  +page-cache-script: the write path of the LRU page cache (the read path
::  lives in +sw-js). The worker only READS the 'lattice-pages' cache — it
::  must never fetch — so every reader document, once painted and after a
::  2.5s user-idle window (user requests queue first on a one-event-at-a-
::  time ship), refetches ITSELF from page context (credentialed on every
::  engine). A NETWORK-served paint defers that refetch to a 12s idle (45s
::  cap): its content is seconds old, the refetch only populates the cache,
::  and firing it at 2s taxed every browse click — read for a moment, click
::  a link, and the click queued behind the previous page's refetch on the
::  one-event-at-a-time pier: ~5s per click, in exactly the read-then-click
::  rhythm people browse at. A CACHE-served paint keeps the prompt window:
::  engine), puts the fresh copy under its canonical URL (?u= stripped, so
::  command results refresh the canonical entry), stamps an LRU index in
::  IndexedDB (url -> {size, at}), and evicts least-recently-viewed entries
::  past the budget. 200MB at ~15KB a page is ~13k pages: eviction is the
::  emergency brake, not the steady state (localStorage.latCacheBudget
::  overrides it so the harness can prove eviction without 200MB of pages).
::  No reload here: a stale paint converges quietly and the NEXT view is
::  fresh — the regime's rule is that only a first-ever view, or the first
::  after eviction, is slow.
::
++  page-cache-script
  ^-  tape
  %-  trip
  '<script>(function(){if(!("caches"in window)||!window.indexedDB)return;var PN=location.pathname;if(PN==="/apps/lattice/clip"||PN==="/apps/lattice/share")return;var BUDGET=(+localStorage.latCacheBudget)||200*1024*1024;var canon=(function(){var h=location.href.split("#")[0];var i=h.indexOf("?");if(i<0)return h;var q=h.slice(i+1).split("&").filter(function(s){return s.slice(0,2)!=="u="});return q.length?h.slice(0,i)+"?"+q.join("&"):h.slice(0,i)})();function idb(){return new Promise(function(res,rej){var r=indexedDB.open("lattice-lru",1);r.onupgradeneeded=function(){r.result.createObjectStore("e",{keyPath:"url"})};r.onsuccess=function(){res(r.result)};r.onerror=function(){rej(r.error)}})}function tx(db,mode,fn){return new Promise(function(res,rej){var t=db.transaction("e",mode);fn(t.objectStore("e"));t.oncomplete=function(){res()};t.onerror=function(){rej(t.error)}})}function touch(url,size){return idb().then(function(db){return tx(db,"readwrite",function(st){var g=st.get(url);g.onsuccess=function(){var e=g.result||{url:url,size:0};e.at=Date.now();if(size)e.size=size;st.put(e)}})}).catch(function(x){})}function evict(){return idb().then(function(db){var all=[];return tx(db,"readonly",function(st){st.openCursor().onsuccess=function(ev){var c=ev.target.result;if(c){all.push(c.value);c.continue()}}}).then(function(){var total=all.reduce(function(a,e){return a+(e.size||0)},0);if(total<=BUDGET)return;all.sort(function(a,b){return(a.at||0)-(b.at||0)});return caches.open("lattice-pages").then(function(c){var i=0;function step(){if(i>=all.length||total<=BUDGET)return;var e=all[i++];total-=(e.size||0);return c.delete(e.url).then(function(){return tx(db,"readwrite",function(st){st.delete(e.url)})}).then(step)}return step()})})}).catch(function(x){})}var swReady=("serviceWorker"in navigator)?Promise.race([navigator.serviceWorker.ready.catch(function(){}),new Promise(function(r){setTimeout(r,3000)})]):Promise.resolve();var shown=null;caches.open("lattice-pages").then(function(c){return c.match(canon)}).then(function(r){return r?r.text():null}).then(function(t){shown=t}).catch(function(x){});function strip(t){return t.replace(/var REV="[^"]*"/,"")}function drop(){return caches.open("lattice-pages").then(function(c){return c.delete(canon)}).then(function(){return idb()}).then(function(db){return tx(db,"readwrite",function(st){st.delete(canon)})}).catch(function(x){})}var inflight=null;function refresh(force){if(inflight&&!force)return inflight;var p=swReady.then(function(){return fetch(location.href,{credentials:"same-origin",cache:"no-store",headers:{"x-lattice-bg":"1"}}).then(function(r){if(r.redirected||r.status===403||r.status===404||r.status===410){return drop().then(function(){return false})}if(!r.ok)return false;return r.blob().then(function(body){return caches.open("lattice-pages").then(function(c){return body.text().then(function(nt){var chg=shown===null||strip(shown)!==strip(nt);if(shown===null)shown=nt;return c.put(canon,new Response(body,{status:200,headers:{"content-type":r.headers.get("content-type")||"text/html"}})).then(function(){return touch(canon,body.size)}).then(evict).then(function(){return{ok:true,chg:chg}})})})})})}).catch(function(x){return false}).then(function(ok){if(inflight===p)inflight=null;return ok});inflight=p;return p}window.__latRefresh=refresh;window.__latCanon=canon;touch(canon,0);var last=Date.now();addEventListener("pointerdown",function(){last=Date.now()},true);addEventListener("keydown",function(){last=Date.now()},true);var nav0=performance.getEntriesByType("navigation")[0];var fresh=!!(nav0&&nav0.transferSize>0);var IDLE=fresh?12000:8000;var CAP=fresh?45000:20000;var t0=Date.now();var iv=setInterval(function(){if(Date.now()-last>IDLE||Date.now()-t0>CAP){clearInterval(iv);refresh()}},500);var oic=/Chrome\//.test(navigator.userAgent);if(fresh&&oic){swReady.then(function(){return fetch(location.href,{cache:"only-if-cached",mode:"same-origin",credentials:"same-origin"})}).then(function(r){if(!r.ok||r.redirected)throw 0;return r.blob()}).then(function(body){return body.text().then(function(nt){shown=nt;return caches.open("lattice-pages").then(function(c){return c.put(canon,new Response(body,{status:200,headers:{"content-type":"text/html"}}))}).then(function(){return touch(canon,body.size)})})}).then(function(){clearInterval(iv)}).catch(function(x){})}})();</script>'
::  +nav-script: contextual back/forward + the hamburger. The stack is the
::  TAB's own (sessionStorage), indexed by a latI stamped into history.state
::  so a traversal is told apart from a new navigation: a load carrying latI
::  is a return to that entry; a load without one truncates the forward
::  branch at the previous position and pushes. Buttons stay disabled until
::  there is genuinely somewhere to go. history.back()/forward() do the
::  moving, so traversals ride the pages cache (instant) and bfcache.
::
++  nav-script
  ^-  tape
  %-  trip
  '<script>(function(){var b=document.getElementById("navb"),f=document.getElementById("navf");var h=document.getElementById("ham"),m=document.getElementById("hammenu");if(h&&m){h.addEventListener("click",function(e){e.preventDefault();e.stopPropagation();m.hidden=!m.hidden});document.addEventListener("click",function(){m.hidden=true})}if(!b||!f)return;var ents=[],pos=-1;try{ents=JSON.parse(sessionStorage.latNav||"[]")}catch(e){}var prev=+(sessionStorage.latNavPos||-1);var st=history.state&&typeof history.state.latI==="number"?history.state.latI:null;if(st!==null&&st<ents.length){pos=st}else if(prev>=0&&ents[prev]===location.href){pos=prev;history.replaceState({latI:pos},"")}else{ents=ents.slice(0,prev+1);ents.push(location.href);if(ents.length>400){ents=[location.href]}pos=ents.length-1;history.replaceState({latI:pos},"")}try{sessionStorage.latNav=JSON.stringify(ents);sessionStorage.latNavPos=String(pos)}catch(e){}function sync(){var si=history.state&&typeof history.state.latI==="number"?history.state.latI:pos;pos=si;try{sessionStorage.latNavPos=String(pos)}catch(e){}if(pos>0){b.removeAttribute("disabled")}else{b.setAttribute("disabled","")}if(pos<ents.length-1){f.removeAttribute("disabled")}else{f.setAttribute("disabled","")}}sync();window.addEventListener("pageshow",function(ev){if(ev.persisted){try{ents=JSON.parse(sessionStorage.latNav||"[]")}catch(e){}sync()}});b.addEventListener("click",function(){history.back()});f.addEventListener("click",function(){history.forward()})})();</script>'
++  sw-register-script
  ^-  tape
  %-  trip
  '<script>if("serviceWorker"in navigator){navigator.serviceWorker.register("/apps/lattice/sw.js",{scope:"/apps/lattice"}).then(function(r){r.addEventListener("updatefound",function(){var w=r.installing;if(w)w.addEventListener("statechange",function(){if(w.state==="installed"&&navigator.serviceWorker.controller)w.postMessage("skipWaiting")})})}).catch(function(x){});var swReloading=false;if(navigator.serviceWorker.controller){navigator.serviceWorker.addEventListener("controllerchange",function(){if(swReloading)return;if(window.__latUnsaved&&window.__latUnsaved())return;swReloading=true;location.reload()})}}</script>'
::  +esc: HTML-escape a tape. +url-enc: percent-encode a tape for a query
::  value. +has-prefix: tape prefix test.
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
::  +url-enc: percent-encode a tape so it survives as a single query-string
::  value. Letters, digits, and -_.~ pass through unchanged; everything else
::  (including & # ? and a stray %) becomes %XX, uppercase hex. Apply this to
::  a raw url BEFORE +esc when it goes into an href's query value: the two
::  layers, query-value escaping then html-attribute escaping, stay in that
::  order.
::
++  url-enc
  |=  t=tape
  ^-  tape
  =/  hx
    |=  n=@
    ^-  @tD
    ?:  (lth n 10)
      (add '0' n)
    (add 'A' (sub n 10))
  %-  zing
  %+  turn  t
  |=  c=@tD
  ^-  tape
  ?:  ?|  &((gte c 'a') (lte c 'z'))
          &((gte c 'A') (lte c 'Z'))
          &((gte c '0') (lte c '9'))
          =(c '-')  =(c '_')  =(c '.')  =(c '~')
      ==
    ~[c]
  ~['%' (hx (div c 16)) (hx (mod c 16))]
++  has-prefix  |=([pre=tape t=tape] =(pre (scag (lent pre) t)))
::  +ltrim: drop leading spaces from a tape (gemtext allows extra whitespace
::  after the "=> " sigil; the analyzer already strips it, render-gmi must too).
::
++  ltrim
  |=  a=tape
  ^-  tape
  ?~  a  a
  ?:(=(' ' i.a) $(a t.a) a)
::  +render-gmi: gemtext body -> HTML fragment. Lives in /lib/lattice-gmi
::  now, beside its tests, the same way render-md always has. It sat here
::  untested and had shipped two bugs a single test would have caught.
::
++  render-gmi  render-gmi:lgmi
::  +content-env-pre: the exact page-source shell EVERY content note is stored
::  in. The evaluator only knows Hoon gates, so a note IS a gate returning
::  (BUILDER '...'): +wrap-content escapes the prose into a single-quote cord
::  and drops it in here; +unwrap-content matches this shell to recover the
::  prose for editing. Keep those two in lockstep with this string.
::
++  content-env-pre  "|=  [cmd=(unit @t) dat=(unit *) now=@da deps=(list [path *])]  ^-  result  ("
::  +make-folder-index: the generated code for an `index`-type page, a gate
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
::  +unesc-content: decode +wrap-content's escaping directly, a linear scan
::  instead of the old ream+slap (a full hoon parse + eval per page read,
::  which every page-tree/page-dump/home request paid per page). The scheme
::  is exactly what +wrap-content emits: \\ -> backslash, \' -> quote,
::  \XX -> hex byte (controls). Anything else malformed yields ~, and the
::  caller treats the page as raw hoon, same as a failed parse did.
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
++  content-builders  `(set @tas)`(sy ~[%md %gmi %html %text %js %css %tex])
::  +name-pax: a ?name= value (slash-separated, e.g. notes/todo) -> a validated
::  page path under /page, or ~. Each segment must be a non-empty @ta knot.
::
::  +raw-name-pax: parse a name to a path WITHOUT the dot-segment check. Only
::  deletion uses it. Tightening +name-pax would otherwise strand any page
::  created before the check landed, because page-del validates the same way
::  it writes, so bad names would become permanently undeletable.
++  raw-name-pax
  |=  n=@t
  ^-  (unit path)
  =/  r  (mule |.(`path`(stab (crip (weld "/" (trip n))))))
  ?.  ?=(%& -.r)  ~
  ?~  p.r  ~
  ?.  (levy `path`p.r |=(seg=@ta &(!=(%$ seg) ((sane %ta) seg))))  ~
  `p.r
++  name-pax
  |=  n=@t
  ^-  (unit path)
  =/  r  (raw-name-pax n)
  ?~  r  ~
  ::  reject '.' and '..' segments. Both are ordinary @ta knots, so (sane %ta)
  ::  admits them, and a page named '../../etc/passwd' is inert HERE (a knot is
  ::  not a parent reference in a grubbery path) but page-tree then hands that
  ::  string to every client. Anything that joins it onto a real filesystem
  ::  path, the FUSE mount, an export, a static-site build, walks out of its
  ::  own directory. Found by scripts/fuzz-api.mjs.
  ?.  (levy u.r |=(seg=@ta &(!=('.' seg) !=('..' seg))))  ~
  r
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
::  +read-tree: every node under /page (sorted) as [path page=?]. page=%.y is a
::  programmable page (a dir with a /code grub), page=%.n a plain folder (incl.
::  empty ones, made by +folder-new). Feeds the editor's nested tree sidebar.
::
++  read-tree
  =/  m  (fiber:fiber:nexus ,(list [pax=path page=?]))
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  ;<  sn=view:nexus  bind:m  (peek:io (rv up /page) ~)
  ?.  ?=([%ball *] sn)  (pure:m ~)
  %-  pure:m
  %+  sort  (collect-tree ball.sn ~)
  |=([a=[pax=path page=?] b=[pax=path page=?]] (aor pax.a pax.b))
::  +read-page-names: just the page paths (folders dropped). The home landing
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
::  +search-results-html: the omnibar results page. A heading plus a #results
::  div filled by client JS that fans out ONE /content-search call per query
::  word (the index has no OR, so the client unions the per-term hits and ranks
::  by words-matched then tf) and links each hit to the reader. Built with the
::  DOM API (textContent) so result text is XSS-safe; single-quote cord so the
::  JS braces stay literal (no ' or \ inside).
::
::  The badge is load-bearing, not decoration. These results mix content that is
::  on the open web with private notes, on a screen the owner may be sharing, so
::  each row states its exposure: clearweb (open web), urbit (other ships only),
::  private (nobody), knowledge (private note).
::
::  `our` is interpolated because a published page's link is built from it.
++  search-results-html
  |=  [q=@t our=@p]
  ^-  tape
  ;:  weld
    "<h1>Search</h1>"
    "<p class=\"muted\">Results for &ldquo;"  (esc (trip q))  "&rdquo; across your pages and notes.</p>"
    "<div id=\"results\" class=\"muted\">Searching&hellip;</div>"
    :(weld "<script>var OUR=\"" (scow %p our) "\";</script>")
    %-  trip
    '<style>.qbadge{display:inline-block;padding:1px 7px;margin-right:.5em;border-radius:999px;border:1px solid #8886;font-size:.75rem;vertical-align:middle;white-space:nowrap}.qbadge.clearweb{border-color:#1a6ed8;color:#1a6ed8}.qbadge.urbit{border-color:#7a5af8;color:#7a5af8}.qbadge.private{border-color:#8a8a8a;color:#8a8a8a}.qbadge.knowledge{border-color:#0a9a6a;color:#0a9a6a}</style>'
    ::  one fan-out per query word; see the arm comment. The minified source
    ::  lives in scratch as search.js. It is checked with `node --check` before
    ::  being pasted here, and contains no single quote or backslash so it needs
    ::  no cord escaping.
    %-  trip
    '<script>(function(){var p=new URLSearchParams(location.search);var q=(p.get("url")||"").trim();var out=document.getElementById("results");if(!q){out.textContent="";return}var words=q.toLowerCase().split(/[^a-z0-9]+/).filter(function(w){return w.length>=2});if(!words.length){out.textContent="Type at least one search word (2+ letters).";return}function get(u){return fetch(u).then(function(r){return r.ok?r.json():{rows:[]}}).catch(function(){return{rows:[]}})}var calls=words.map(function(w){return get("/apps/lattice/content-search?term="+encodeURIComponent(w))});Promise.all(calls).then(function(res){var hits={};function bump(scope,key,tf){var k=scope+"|"+key;if(!hits[k])hits[k]={scope:scope,key:key,terms:0,tf:0};hits[k].terms++;hits[k].tf+=tf;}res.forEach(function(j){var c=j.columns||[];var rows=j.rows||[];var si=c.indexOf("scope"),ki=c.indexOf("key"),ti=c.indexOf("tf");rows.forEach(function(row){var s=row[si],k=row[ki];if(!s||!k)return;bump(s,k,parseInt(row[ti],10)||0);});});var list=Object.keys(hits).map(function(k){return hits[k]});list.sort(function(a,b){return b.terms-a.terms||b.tf-a.tf});out.textContent="";out.className="";if(!list.length){out.className="muted";out.textContent="Nothing matches that.";return}var ul=document.createElement("ul");ul.className="qlist";list.slice(0,50).forEach(function(h){var href;if(h.scope==="knowledge"){href="/apps/lattice/app?view=know&name="+encodeURIComponent(h.key)}else if(h.scope==="private"){href="/apps/lattice/app?name="+encodeURIComponent(h.key)}else{href="/apps/lattice?url="+encodeURIComponent("urb://"+OUR+"/"+h.key)}var li=document.createElement("li");var a=document.createElement("a");a.href=href;var b=document.createElement("span");b.className="qbadge "+h.scope;b.textContent=h.scope;var n=document.createElement("span");n.className="qname";n.textContent=h.key;var s=document.createElement("span");s.className="qprev";s.textContent=h.terms+(h.terms>1?" terms":" term")+", tf "+h.tf;a.appendChild(b);a.appendChild(n);a.appendChild(s);li.appendChild(a);ul.appendChild(li);});out.appendChild(ul);}).catch(function(){out.className="muted";out.textContent="Search is unavailable.";});})();</script>'
  ==
::  +clip-paste-html: the landing page the send-page bookmarklet opens. Its only
::  job is to be same-origin with the api: it receives the html over
::  postMessage from the tab that opened it and POSTs it to /clip-html, then
::  replaces itself with the archive confirmation.
::
::  The sender is the article page, so its origin is arbitrary and cannot be
::  whitelisted. What IS checked is that the message came from window.opener,
::  and the payload shape. Worth being clear about the residual exposure: a
::  hostile page the user clicks the bookmarklet on could send content other
::  than what is displayed. That is the same trust as /clip (junk in your own
::  tree, nothing disclosed), but here the content is arbitrary rather than
::  fetched, so it is a step further.
++  clip-paste-html
  |=  url=@t
  ^-  @t
  %-  render-page
  :^    ""  ""  ""
  ;:  weld
    "<h1>Archiving from your browser</h1>"
    "<p class=\"muted\">"  (esc (trip url))  "</p>"
    "<div id=\"pst\" class=\"muted\">waiting for the page&hellip;</div>"
    "<script>"
    %-  trip
    '(function(){var out=document.getElementById("pst");var p=new URLSearchParams(location.search);var u=p.get("url")||"";var done=false;function show(m,bad){out.textContent=m;out.className=bad?"err":"";}function send(html){if(done)return; done=true;show("archiving…");fetch("/apps/lattice/clip-html?url="+encodeURIComponent(u),{method:"POST",body:html}).then(function(r){if(r.ok){return r.text().then(function(t){document.open();document.write(t);document.close();});}return r.json().catch(function(){return{}}).then(function(j){show("could not archive"+(j.error?": "+j.error:" ("+r.status+")"),true);});}).catch(function(){show("could not archive (network error)",true);});}window.addEventListener("message",function(e){if(e.source!==window.opener)return;var d=e.data;if(!d||d.lattice!==1||typeof d.html!=="string")return;send(d.html);});try{if(window.opener)window.opener.postMessage({lattice:"ready"},"*");}catch(x){}setTimeout(function(){if(!done)show("nothing arrived from the page — try the bookmarklet again",true);},15000);})();'
    "</script>"
  ==
::  +settings-html: the settings page. Search-index maintenance, the browser
::  bookmarklets and the vault backup UI. Single-quote cords so the css and js
::  braces stay literal (no ' or \ inside).
::
++  settings-html
  ^-  tape
  ;:  weld
    %-  trip
    ::  color-scheme on the form controls is what stops the OS drawing them
    ::  light-on-dark: the app's rule is that no control ships with foreign
    ::  widget chrome. The native select arrow is kept (appearance:none with no
    ::  replacement chevron would leave no affordance at all).
    '<style>.btn{padding:8px 16px;font:inherit;border:1px solid #8886;border-radius:8px;background:transparent;color:inherit;cursor:pointer}.btn:hover{border-color:#1a6ed8}.btn:disabled{opacity:.5;cursor:default}select,option,input[type=range]{color-scheme:light dark}select{font:inherit;color:inherit;background:transparent;border:1px solid #8886;border-radius:6px;padding:5px 8px;cursor:pointer}select:hover,select:focus{border-color:#1a6ed8;outline:none}input[type=range]{vertical-align:middle;accent-color:#1a6ed8;cursor:pointer}label{color:#8a8a8a}.bklist{list-style:none;padding:0;margin:.4rem 0}.bklist li{margin:.4rem 0;padding:.5rem .7rem;border:1px solid #8886;border-radius:8px}.bkrow{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin:.4rem 0}.err{color:#c0392b}</style>'
    "<h1>Settings</h1>"
    "<h2>Search index</h2>"
    "<p class=\"muted\">The omnibar searches your published pages, your private page sources and your knowledge entries, labelling each result with where it lives. The index is rebuilt on demand rather than continuously, so reindex after a batch of edits to make them findable.</p>"
    "<p><button type=\"button\" id=\"sreidx\" class=\"btn\">Reindex my content</button> <span id=\"srst\" class=\"muted\"></span></p>"
    %-  trip
    '<script>(function(){var b=document.getElementById("sreidx");var s=document.getElementById("srst");b.onclick=function(){b.disabled=true;s.textContent="reindexing...";fetch("/apps/lattice/search-reindex",{method:"POST"}).then(function(r){s.textContent=r.ok?"done - your pages and notes are searchable.":"failed ("+r.status+")";b.disabled=false}).catch(function(){s.textContent="failed (network error)";b.disabled=false})}})();</script>'
    ::  backup: manual export/restore for everyone, plus (desktop only) the
    ::  scheduled backups. The whole UI is rendered by ui-app/vault.js's
    "<h2>Commons mirror</h2>"
    "<p class=\"muted\">Mirrors your pages, notes, tags and follows into the %obelisk database, where you (and your agents) can query across apps with urQL. Optional: without %obelisk everything else works unchanged.</p>"
    "<p><span id=\"obst\" class=\"muted\">checking&hellip;</span></p>"
    "<p><button type=\"button\" id=\"obinst\" class=\"btn\" hidden>Install %obelisk</button> "
    "<label for=\"obon\" id=\"obonl\" hidden><input type=\"checkbox\" id=\"obon\"> mirror enabled</label></p>"
    %-  trip
    '<script>(function(){var st=document.getElementById("obst");var bi=document.getElementById("obinst");var lb=document.getElementById("obonl");var cb=document.getElementById("obon");function show(d){if(d.installed){bi.hidden=true;lb.hidden=false;cb.checked=!!d.enabled;st.textContent="%obelisk is installed."}else{bi.hidden=false;lb.hidden=true;st.textContent="%obelisk is not installed."}}function load(){fetch("/apps/lattice/obelisk-status").then(function(r){return r.json()}).then(show).catch(function(){st.textContent="status unavailable"})}bi.onclick=function(){bi.disabled=true;st.textContent="installing from ~dister-nomryg-nilref (this can take a while)...";fetch("/apps/lattice/obelisk-install",{method:"POST"}).then(function(){var n=0;var busy=false;var t=setInterval(function(){if(busy){return}n++;busy=true;fetch("/apps/lattice/obelisk-status").then(function(r){return r.json()}).then(function(d){busy=false;if(d.installed){clearInterval(t);bi.disabled=false;show(d)}else if(n>40){clearInterval(t);bi.disabled=false;st.textContent="still not installed - check your ship is connected and retry."}}).catch(function(){busy=false;if(n>40){clearInterval(t);bi.disabled=false;st.textContent="still not installed - check your ship is connected and retry."}})},6000)}).catch(function(){bi.disabled=false;st.textContent="install request failed - retry."})};cb.onchange=function(){fetch("/apps/lattice/mirror-config?enabled="+(cb.checked?"true":"false"),{method:"POST"}).then(load).catch(load)};load()})();</script>'
    ::  the backup section shares the editor's exact tar writer/reader through
    ::  LatticeVault, so the archive a schedule writes and the one this page
    ::  exports are the same file. This page is a separate document from the
    ::  editor bundle, so it loads vault.js on its own; the external script is
    ::  parser-blocking, so LatticeVault exists by the time the wiring runs.
    "<h2>Backup</h2>"
    "<div id=\"vaultui\"></div>"
    %-  trip
    '<script src="/apps/lattice/app/vault.js"></script>'
    %-  trip
    '<script>window.LatticeVault&&LatticeVault.mountSettings(document.getElementById("vaultui"))</script>'
    ::  typography: a CLIENT-ONLY preference. It writes localStorage and the
    ::  editor (ui-app/src/05-prefs.js) applies it to --ed-font / --ed-size, so
    ::  changing it costs zero requests and never touches the pier. An editor
    ::  open in another tab updates through the storage event, no reload.
    "<h2>Typography</h2>"
    "<p class=\"muted\">Font and size for the editor. Saved in this browser only &mdash; it never touches your ship, so it costs no round-trip. An editor open in another tab picks the change up immediately.</p>"
    ::  vim mode. Same shape as the typography controls above: this page is a
    ::  separate document, so it only writes localStorage and the editor picks
    ::  the change up through the storage event. Off unless explicitly on.
    "<p><label for=\"vimsel\"><input type=\"checkbox\" id=\"vimsel\"> vim mode in the editor</label> "
    "<span class=\"muted\">modal editing: Esc for normal, i to insert, :w to save.</span></p>"
    "<p><label for=\"fontsel\">Font </label><select id=\"fontsel\"><option value=\"mono\">Monospace (default)</option><option value=\"system\">System sans</option><option value=\"serif\">Serif</option><option value=\"humanist\">Coding (Iosevka, JetBrains Mono)</option></select> <label for=\"fontsize\">Size </label><input type=\"range\" id=\"fontsize\" min=\"9\" max=\"32\" step=\"1\"> <span id=\"fontsizeo\" class=\"muted\"></span> <button type=\"button\" id=\"fontreset\" class=\"btn\">Reset</button></p>"
    ::  NB: no curly braces in this tape. hoon interpolates "{...}" inside a
    ::  double-quoted tape, so a literal brace is a syntax error here. (The
    ::  script below is a single-quoted cord, which is literal, braces and all.)
    "<p id=\"fontsample\" style=\"border:1px solid #8886;border-radius:8px;padding:12px\">The quick brown fox jumps over the lazy dog &middot; 0123456789 &middot; il1 O0 &middot; |= ^- @ud</p>"
    %-  trip
    '<script>(function(){var f=document.getElementById("fontsel"),s=document.getElementById("fontsize"),o=document.getElementById("fontsizeo"),p=document.getElementById("fontsample");var M={mono:"ui-monospace, Menlo, Consolas, monospace",system:"system-ui, sans-serif",serif:"Georgia, Times New Roman, serif",humanist:"Iosevka, JetBrains Mono, Fira Code, ui-monospace, monospace"};function draw(){p.style.fontFamily=M[f.value]||M.mono;p.style.fontSize=s.value+"px";o.textContent=s.value+"px"}function save(){try{localStorage.latFont=f.value;localStorage.latFontSize=s.value}catch(e){}draw()}try{f.value=localStorage.latFont||"mono";s.value=localStorage.latFontSize||"13"}catch(e){}if(!M[f.value])f.value="mono";if(!(s.value>=9))s.value="13";draw();f.onchange=save;s.oninput=save;var v=document.getElementById("vimsel");try{v.checked=localStorage.edVim==="1"}catch(e){}v.onchange=function(){try{localStorage.edVim=v.checked?"1":"0"}catch(e){}};document.getElementById("fontreset").onclick=function(){try{localStorage.removeItem("latFont");localStorage.removeItem("latFontSize")}catch(e){}f.value="mono";s.value="13";draw()}})();</script>'
    "<h2>Archive a web page</h2>"
    "<p class=\"muted\">Drag this to your bookmarks bar. On any web page, click it and your ship fetches that page, converts it to markdown and files it privately under <code>clips/</code> &mdash; a real lattice page you can edit, search and share.</p>"
    "<p><a id=\"clipbm\" class=\"btn\" href=\"#\">Clip to lattice</a></p>"
    "<p class=\"muted\">Some publishers refuse automated fetches (you&rsquo;ll see a 403), and a paywalled or logged-in page is never fetchable by the ship at all. Use this second bookmark for those: it sends the page <em>your browser is already showing</em>, so nothing is requested from the site.</p>"
    "<p><a id=\"sendbm\" class=\"btn\" href=\"#\">Send page to lattice</a></p>"
    ::  the bookmarklet source lives in a text/plain block with an __O__
    ::  placeholder rather than being built inside the wiring script: nesting a
    ::  quoted js program inside another quoted js string needs backslash
    ::  escaping, which then needs hoon escaping on top. This keeps both free of
    ::  single quotes and backslashes.
    %-  trip
    '<script type="text/plain" id="bmsrc">(function(){var h=document.documentElement.outerHTML;var o=__O__;var w=window.open(o+"/apps/lattice/clip-paste?url="+encodeURIComponent(location.href),"_blank");if(!w){alert("Allow popups for this site to send the page to lattice.");return}var n=0;var t=setInterval(function(){n++;try{w.postMessage({lattice:1,html:h},o)}catch(e){}if(n>40)clearInterval(t)},250);window.addEventListener("message",function(e){if(e.data&&e.data.lattice==="ready"){try{w.postMessage({lattice:1,html:h},o)}catch(x){}}})})()</script>'
    %-  trip
    '<script>(function(){var a=document.getElementById("sendbm");var s=document.getElementById("bmsrc").textContent.trim().replace("__O__",JSON.stringify(location.origin));a.href="javascript:"+s;a.onclick=function(e){e.preventDefault()}})();</script>'
    ::  the bookmarklet href is built client-side because settings-html has no
    ::  idea what host the browser reached us on (ship domain, localhost, a
    ::  reverse proxy). location.origin is the only thing that knows.
    %-  trip
    '<script>(function(){var a=document.getElementById("clipbm");a.href="javascript:(function(){location.href=\'"+location.origin+"/apps/lattice/clip?url=\'+encodeURIComponent(location.href)})()";a.onclick=function(e){e.preventDefault()}})();</script>'
  ==
::  +home-index-html: the landing page. Always shows navigation (Pages,
::  Explorer) plus a live list of your programmable pages and any published
::  pages, so an empty store is still a way in, not a dead end.
::
++  home-index-html
  |=  [our=@p recent=(list [pax=path prev=@t]) bms=bookmarks:lb know=tape]
  ^-  tape
  =/  ship=tape  (scow %p our)
  =/  tree=tape  :(weld "/apps/lattice/x/" ship "/")
  ::  under Editor: the 10 most recently edited pages, name + a preview, each
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
  ::  under Browser: the last 10 bookmarks. The title opens the saved url via the
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
        "<li><a href=\"/apps/lattice?url="  (esc (url-enc (trip url.b)))  "\">"
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
    "<h3 class=\"qh\"><a href=\"/apps/lattice/marks\">Bookmarks &#8594;</a></h3>"
    bm-list
    "</div>"
    "<div class=\"col\">"
    "<a class=\"appcard\" href=\"/apps/lattice/know\"><span class=\"ico\">&#128218;</span><strong>Knowledge</strong><span class=\"d\">The private memory store &mdash; tagged notes your assistant recalls and saves.</span></a>"
    "<h3 class=\"qh\">Recent memories</h3>"
    know
    "</div>"
    "</div>"
  ==
::  +remote-comment-box: the form that comments on ANOTHER ship's page.
::
::  Posts to our own ship, which forwards the poke. The response says "sent",
::  not "posted": a peer refuses silently by design (banlist, comments off),
::  so claiming success here would be inventing a fact we do not have.
::
++  remote-comment-box
  |=  [shp=@p rel=path]
  ^-  tape
  =/  st=tape   (scow %p shp)
  =/  pg=tape   (slag 1 (spud rel))
  ;:  weld
    "<section class=\"cbox-wrap\"><h3>Comment</h3>"
    "<form class=\"cbox\" method=\"post\" target=\"_top\" action=\"/apps/lattice/comment-remote?ship="
    (esc st)  "&amp;page="  (esc pg)  "\">"
    "<textarea name=\"body\" rows=\"3\" placeholder=\"say something to "
    (esc st)  "\"></textarea>"
    "<button type=\"submit\">send to "  (esc st)  "</button>"
    "</form>"
    "<p class=\"muted\">Sent over Ames from your ship, so "  (esc st)
    " sees your @p as the author. They decide whether it appears.</p>"
    "</section>"
  ==
::  +marks-html: the full bookmark list, every bookmark grouped by folder
::  (unfiled first: it is where the star button files things), a search box
::  filtering client-side over title+url+folder, and per-row refile/delete.
::  Actions call the JSON routes and reload; the page itself stays dumb.
::
++  marks-html
  |=  bms=bookmarks:lb
  ^-  tape
  =/  folders=(list @t)
    =/  uniq=(list @t)
      %+  sort  ~(tap in (~(gas in *(set @t)) (turn bms |=(b=bookmark:lb folder.b))))
      aor
    ?.  (lien uniq |=(f=@t =('' f)))  uniq
    ['' (skip uniq |=(f=@t =('' f)))]
  =/  groups=tape
    %-  zing
    %+  turn  folders
    |=  f=@t
    =/  mine=bookmarks:lb  (skim bms |=(b=bookmark:lb =(folder.b f)))
    =/  fname=tape  ?:(=('' f) "unfiled" (esc (trip f)))
    =/  mine=bookmarks:lb  (skim bms |=(b=bookmark:lb =(folder.b f)))
    =/  rows=tape
      %-  zing
      %+  turn  mine
      |=  b=bookmark:lb
      =/  u=tape  (esc (trip url.b))
      =/  hu=tape  (esc (url-enc (trip url.b)))
      =/  t=tape  (esc (trip title.b))
      =/  fo=tape  (esc (trip folder.b))
      %-  zing
      :~  "<li data-t=\""  t  " "  u  " "  fo  "\">"
          "<a href=\"/apps/lattice?url="  hu  "\">"
          "<span class=\"qname\">"  t  "</span>"
          "<span class=\"qprev\">"  u  "</span></a>"
          "<span class=\"bmops\">"
          "<input value=\""  fo  "\" placeholder=\"folder\">"
          "<button data-act=\"move\" data-url=\""  u  "\">file</button>"
          "<button data-act=\"del\" data-url=\""  u  "\" title=\"remove bookmark\">&#215;</button>"
          "</span></li>"
      ==
    ;:  weld
      "<section class=\"bmgrp\"><h3 class=\"qh\">"
      fname
      "</h3><ul class=\"qlist\">"
      rows
      "</ul></section>"
    ==
  ;:  weld
    "<style>"  marks-css  "</style>"
    "<h1>Bookmarks</h1>"
    ?~  bms
      "<p class=\"muted\">No bookmarks yet &mdash; open a page in the Browser and hit &#9734;.</p>"
    %+  weld
      "<input id=\"bmq\" type=\"search\" placeholder=\"search bookmarks\" autocomplete=\"off\">"
    groups
    marks-script
  ==
::  +marks-css / +marks-script: single-quoted cords, so braces stay literal
::  and the script uses double-quoted JS strings throughout.
::
++  marks-css
  ^-  tape
  %-  trip
  '#bmq{width:100%;padding:8px 10px;font:inherit;border:1px solid #8886;border-radius:8px;background:transparent;color:inherit;margin:.4rem 0 .8rem}.bmgrp li{display:flex;align-items:center;gap:8px}.bmgrp li a{flex:1;min-width:0}.bmops{display:flex;gap:4px;align-items:center}.bmops input{width:8.5em;padding:4px 6px;font:inherit;font-size:.82rem;border:1px solid #8886;border-radius:6px;background:transparent;color:inherit}.bmops button{padding:4px 9px;font:inherit;font-size:.82rem;border:1px solid #8886;border-radius:6px;background:transparent;color:inherit;cursor:pointer}.bmops button:hover{border-color:#1a6ed8}@media(max-width:520px){.bmgrp li{flex-wrap:wrap}.bmops{margin-left:auto}}'
++  marks-script
  ^-  tape
  %-  trip
  '<script>document.addEventListener("input",function(e){if(e.target.id!=="bmq")return;var q=e.target.value.toLowerCase();document.querySelectorAll(".bmgrp").forEach(function(g){var vis=0;g.querySelectorAll("li").forEach(function(li){var on=li.dataset.t.toLowerCase().indexOf(q)>=0;li.hidden=!on;if(on)vis++;});g.hidden=!vis;});});document.addEventListener("click",async function(e){var b=e.target.closest("button[data-act]");if(!b)return;e.preventDefault();var u=encodeURIComponent(b.dataset.url);if(b.dataset.act==="del"){if(!confirm("remove this bookmark?"))return;await fetch("/apps/lattice/unbookmark?url="+u,{method:"POST"});}else{var f=b.parentElement.querySelector("input").value.trim();await fetch("/apps/lattice/bookmark-move?url="+u+"&folder="+encodeURIComponent(f),{method:"POST"});}location.reload();});</script>'
::  +web-css: minimal reader styling (single-quoted cord so braces are literal).
::
++  web-css
  ^-  tape
  %+  weld  know-css
  %-  trip
  ':root{--bg:#fff}.navb{font-size:1.05em}.navb[disabled]{opacity:.35;cursor:default}.hamw{position:relative;margin-left:auto;display:flex}.hamw>button{font-size:1.1em}#hammenu{position:absolute;right:0;top:100%;z-index:60;background:var(--bg,#fff);border:1px solid #8886;border-radius:6px;min-width:160px;display:flex;flex-direction:column;padding:4px;box-shadow:0 4px 14px #0003}#hammenu a{padding:7px 10px;text-decoration:none;color:inherit;border-radius:4px}#hammenu a:hover{background:#8882}#hammenu[hidden]{display:none}*{box-sizing:border-box;scrollbar-width:thin;scrollbar-color:#8887 transparent}::-webkit-scrollbar{width:11px;height:11px}::-webkit-scrollbar-thumb{background:#8886;border-radius:6px;border:3px solid transparent;background-clip:content-box}::-webkit-scrollbar-thumb:hover{background:#888a;background-clip:content-box}::-webkit-scrollbar-track{background:transparent}html{background:#fafafa}body{margin:0;font:16px/1.6 system-ui,sans-serif;color:#111;background:#fafafa}@media(prefers-color-scheme:dark){:root{--bg:#1a1a1a}html{background:#1a1a1a}body{color:#e6e6e6;background:#1a1a1a}}.bar{display:flex;gap:6px;padding:8px;border-bottom:1px solid #8884}.bar a.home{display:flex;align-items:center;padding:0 12px;font-size:1.2rem;border:1px solid #8886;border-radius:6px;text-decoration:none;color:inherit}.bar a.home:hover{border-color:#1a6ed8}.bar a.nav{display:flex;align-items:center;padding:0 11px;font-size:1.05rem;border:1px solid #8886;border-radius:6px;text-decoration:none;color:inherit;white-space:nowrap}.bar a.nav:hover{border-color:#1a6ed8}.rawf{width:100%;height:70vh;border:1px solid #8886;border-radius:6px;background:#fff}.muted{color:#8a8a8a;font-size:.9em}.bar input{flex:1;padding:6px 8px;font:inherit;border:1px solid #8886;border-radius:6px;background:transparent;color:inherit}.bar button{padding:0 14px;font:inherit;border:1px solid #8886;border-radius:6px;background:transparent;color:inherit;cursor:pointer}.bar button:hover{border-color:#1a6ed8}main{max-width:46rem;margin:0 auto;padding:16px;overflow-wrap:anywhere}a{color:#1a6ed8}.err{color:#c0392b}blockquote{margin:.6rem 0;padding-left:1rem;border-left:3px solid #8886;color:#8a8a8a}pre{background:#8881;padding:10px;overflow-x:auto;border-radius:6px;white-space:pre}code{background:#8881;padding:.1em .3em;border-radius:4px;font-size:.9em}pre code{background:0;padding:0}table{border-collapse:collapse;margin:.7rem 0;display:block;overflow-x:auto;max-width:100%}th,td{border:1px solid #8887;padding:6px 11px}th{background:#8881;font-weight:600;text-align:left}img{max-width:100%;height:auto}del{opacity:.7}ul,ol{padding-left:1.5rem}li{margin:.15rem 0}sup.fnref{font-size:.72em}sup.fnref a{text-decoration:none}hr.fn-sep{margin-top:2rem}.footnotes{font-size:.88em;color:#8a8a8a}.footnotes li{margin:.25rem 0}.bar{padding-left:max(8px,env(safe-area-inset-left));padding-right:max(8px,env(safe-area-inset-right))}main{padding-left:max(16px,env(safe-area-inset-left));padding-right:max(16px,env(safe-area-inset-right))}@media(max-width:520px){.bar{flex-wrap:wrap}.bar input{flex:1 1 100%;order:3}main{padding-top:12px;padding-bottom:12px}}'
::  +know-css: styles for the knowledge view (single-quote cord: braces literal).
::
++  know-css
  ^-  tape
  %-  trip
  '.muted{color:#8a8a8a}.quick{display:flex;flex-wrap:wrap;gap:8px;margin:.5rem 0 .3rem}.quick a{padding:6px 12px;border:1px solid #8886;border-radius:8px;text-decoration:none;color:inherit;background:#8881;font-size:.9rem}.quick a:hover{border-color:#1a6ed8}.quick a.on{border-color:#1a6ed8;color:#1a6ed8}ul.qlist{list-style:none;padding:0;margin:.4rem 0}ul.qlist li{border-bottom:1px solid #8883;margin:0}ul.qlist a{display:block;padding:9px 6px;text-decoration:none;color:inherit;border-radius:6px}ul.qlist a:hover{background:#8881}.qname{display:block;font-weight:500;color:#1a6ed8}.qprev{display:block;font-size:.84rem;color:#8a8a8a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:.05rem}.know-body{white-space:pre-wrap}'
::  +render-page: wrap an HTML fragment in the reader chrome (address bar +
::  CSS), titled plain "lattice". +render-page-titled is the same chrome with
::  a real <title>, and covers most callers now: the /pub call sites
::  (page-title-of already runs there for the history log), the /x explorer,
::  the knowledge store, settings, marks, search. What is left plain is the
::  generic home listing (no authored /index yet) and the pub-not-found
::  error, surfaces with nothing of their own to call the tab.
::
++  render-page
  |=  [current=tape keep=tape rev=tape inner=tape]
  ^-  @t
  (render-page-titled current keep rev "lattice" inner)
::  +render-page-titled: +render-page with an explicit tab/history title
::  instead of the bare "lattice" fallback.
::
++  render-page-titled
  |=  [current=tape keep=tape rev=tape title=tape inner=tape]
  ^-  @t
  ::  the star shows whenever the address bar holds a real urb:// address.
  ::  It was only on the framed browser view before, so most of the Browser
  ::  (home, published pages, the /x explorer) had no way to bookmark at all.
  ::  Hoisted =/ (not inline in the weld): see the fuse-loop trap.
  =/  bmbtn=tape
    ?.  (has-prefix "urb://" current)  ""
    "<button type=\"button\" class=\"bm\" title=\"Bookmark this page\">&#9734;</button>"
  %-  crip
  ;:  weld
    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">"
    pwa-head
    "<title>"  (esc title)  "</title><style>"  web-css  "</style></head><body>"
    "<form class=\"bar\" action=\"/apps/lattice\" method=\"get\">"
    ::  contextual history: enabled only when this tab has somewhere to go
    ::  (+nav-script maintains the per-tab stack). Everything that used to be
    ::  a row of nav links lives in the hamburger now — including the editor,
    ::  the knowledge store, bookmarks and settings — because an authored
    ::  /index takes over the home view and the bar is what survives it.
    "<button type=\"button\" class=\"navb\" id=\"navb\" title=\"back\" disabled>&#8592;</button>"
    "<button type=\"button\" class=\"navb\" id=\"navf\" title=\"forward\" disabled>&#8594;</button>"
    "<a class=\"home\" href=\"/apps/lattice\" title=\"lattice home\">&#8962;</a>"
    "<input name=\"url\" value=\""  (esc current)  "\" autocomplete=\"off\" placeholder=\"urb:// address or search your pages\">"
    "<button type=\"submit\">Go</button>"
    bmbtn
    "<span class=\"hamw\"><button type=\"button\" id=\"ham\" title=\"menu\">&#9776;</button>"
    "<div id=\"hammenu\" hidden>"
    "<a href=\"/apps/lattice/app\">&#9998; editor</a>"
    "<a href=\"/apps/lattice/know\">&#9670; knowledge</a>"
    "<a href=\"/apps/lattice/marks\">&#9733; bookmarks</a>"
    "<a href=\"/apps/lattice/settings\">&#9881; settings</a>"
    "</div></span>"
    "</form><main>"  inner  "</main>"
    ::  omnibar completions. A STYLED list, deliberately. <datalist> is the
    ::  one-line version and renders as an OS-drawn dropdown that ignores every
    ::  style here, which is not acceptable in this UI.
    %-  trip
    '<style>.bar{position:relative}.omni{position:absolute;left:8px;right:8px;top:100%;z-index:40;background:var(--bg,#fff);border:1px solid #8886;border-radius:8px;overflow:hidden;box-shadow:0 6px 24px #0003;max-height:60vh;overflow-y:auto}.omnirow{display:flex;align-items:baseline;gap:.6em;padding:7px 10px;cursor:pointer;border-bottom:1px solid #8882}.omnirow:last-child{border-bottom:0}.omnirow:hover,.omnirow.on{background:#1a6ed822}.omnisrc{flex:none;font-size:.7rem;padding:1px 6px;border-radius:999px;border:1px solid #8886;opacity:.8}.omnisrc.bookmark{border-color:#1a6ed8;color:#1a6ed8}.omnittl{flex:none;max-width:38%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.omniurl{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.6;font-size:.85rem}@media(prefers-color-scheme:dark){.omni{background:#1f1f1f}}@media(max-width:520px){.omnittl{max-width:50%}.omniurl{display:none}}</style>'
    "<script>"
    %-  trip
    '(function(){var bar=document.querySelector(".bar");var inp=bar?bar.querySelector("input[name=url]"):null;if(!inp)return;var box=document.createElement("div");box.className="omni";box.hidden=true;bar.appendChild(box);var items=[],sel=-1,timer=null,seq=0;function hide(){box.hidden=true;sel=-1;}function pick(i){if(i<0||i>=items.length)return;inp.value=items[i].url;hide();bar.submit();}function draw(){box.textContent="";if(!items.length){hide();return}items.forEach(function(it,i){var row=document.createElement("div");row.className="omnirow"+(i===sel?" on":"");var b=document.createElement("span");b.className="omnisrc "+it.source;b.textContent=it.source==="bookmark"?"saved":"visited";var t=document.createElement("span");t.className="omnittl";t.textContent=it.title||it.url;var u=document.createElement("span");u.className="omniurl";u.textContent=it.url;row.appendChild(b);row.appendChild(t);row.appendChild(u);row.addEventListener("mousedown",function(e){e.preventDefault();pick(i)});box.appendChild(row);});box.hidden=false;}function fetchSug(){var q=inp.value.trim();var my=++seq;fetch("/apps/lattice/omni-suggest?q="+encodeURIComponent(q)).then(function(r){return r.ok?r.json():{items:[]}}).then(function(j){if(my!==seq)return;items=(j.items||[]);sel=-1;draw();}).catch(function(){if(my===seq){items=[];hide()}});}inp.addEventListener("input",function(){clearTimeout(timer);timer=setTimeout(fetchSug,140)});inp.addEventListener("focus",function(){clearTimeout(timer);timer=setTimeout(fetchSug,140)});inp.addEventListener("blur",function(){setTimeout(hide,120)});inp.addEventListener("keydown",function(e){if(box.hidden)return;if(e.key==="ArrowDown"){e.preventDefault();sel=Math.min(sel+1,items.length-1);draw()}else if(e.key==="ArrowUp"){e.preventDefault();sel=Math.max(sel-1,-1);draw()}else if(e.key==="Enter"){if(sel>=0){e.preventDefault();pick(sel)}}else if(e.key==="Escape"){hide()}});})();'
    "</script>"
    %-  trip
    '<script>(function(){var b=document.querySelector(".bm");if(!b)return;b.onclick=function(){var u=document.querySelector(".bar input").value;if(!u)return;fetch("/apps/lattice/bookmark?url="+encodeURIComponent(u)+"&title="+encodeURIComponent(u),{method:"POST"}).then(function(r){if(r.ok){b.innerHTML="&#9733;";b.title="Bookmarked"}})};fetch("/apps/lattice/bookmarks").then(function(r){return r.ok?r.json():null}).then(function(j){var cu=document.querySelector(".bar input").value;if(!cu||!j)return;if((j.items||[]).some(function(it){return it.url===cu})){b.innerHTML="&#9733;";b.title="Bookmarked"}}).catch(function(x){})})();</script>'
    (sse-script keep rev)  nav-script  page-cache-script  sw-register-script  "</body></html>"
  ==
::  +render-browser-page: the browser's page view, the address bar (+ an Edit
::  button when `edit` names an editable own page) above the page rendered in a
::  viewport-filling iframe, so the page's theme owns its whole document (no
::  collision with the chrome css) and looks as it would on the clear web.
::  `sandbox` locks the frame (no scripts/same-origin) for untrusted peer content;
::  `keep` is the data-grub SSE url ("" = none) so an owner edit live-reloads the
::  view. `title` is the page's own tab/history title (its caller already runs
::  +page-title-of), falling back to "lattice" where there is none. The
::  clearweb-parity replacement for the old dev page-view chrome.
::
++  render-browser-page
  |=  [current=tape doc=@t edit=(unit @t) sandbox=? keep=tape rev=tape title=tape]
  ^-  @t
  =/  editbtn=tape
    ?~  edit  ""
    :(weld "<a class=\"eb\" href=\"/apps/lattice/app?name=" (trip u.edit) "\">&#9998; edit</a>")
  %-  crip
  ;:  weld
    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">"
    pwa-head
    "<title>"  (esc title)  "</title><style>"  web-css
    (trip 'html,body{height:100%}body.bp{display:flex;flex-direction:column;margin:0}.bp main{max-width:none;margin:0;padding:0;flex:1;display:flex}.bp .pf{flex:1;width:100%;border:0}.bar .eb,.bar .bm{display:flex;align-items:center;gap:.3em;padding:0 12px;border:1px solid #8886;border-radius:6px;text-decoration:none;color:inherit;white-space:nowrap;background:transparent;cursor:pointer;font-size:1rem}.bar .eb:hover,.bar .bm:hover{border-color:#1a6ed8}')
    "</style></head><body class=\"bp\">"
    "<form class=\"bar\" action=\"/apps/lattice\" method=\"get\">"
    "<button type=\"button\" class=\"navb\" id=\"navb\" title=\"back\" disabled>&#8592;</button>"
    "<button type=\"button\" class=\"navb\" id=\"navf\" title=\"forward\" disabled>&#8594;</button>"
    "<a class=\"home\" href=\"/apps/lattice\" title=\"lattice home\">&#8962;</a>"
    "<input name=\"url\" value=\""  (esc current)  "\" autocomplete=\"off\" placeholder=\"urb:// address or search your pages\">"
    "<button type=\"submit\">Go</button>"
    editbtn
    "<button type=\"button\" class=\"bm\" title=\"Bookmark this page\">&#9734;</button>"
    "<span class=\"hamw\"><button type=\"button\" id=\"ham\" title=\"menu\">&#9776;</button>"
    "<div id=\"hammenu\" hidden>"
    "<a href=\"/apps/lattice/app\">&#9998; editor</a>"
    "<a href=\"/apps/lattice/know\">&#9670; knowledge</a>"
    "<a href=\"/apps/lattice/marks\">&#9733; bookmarks</a>"
    "<a href=\"/apps/lattice/settings\">&#9881; settings</a>"
    "</div></span>"
    "</form>"
    "<main><iframe class=\"pf\""  ?:(sandbox " sandbox=\"\"" "")
    " srcdoc=\""  (esc (trip doc))  "\"></iframe></main>"
    ::  bookmark button: POST the address-bar url to /bookmark (owner-gated, same
    ::  origin). single-quote cord so the js braces stay literal.
    %-  trip
    '<script>(function(){var b=document.querySelector(".bm");if(!b)return;b.onclick=function(){var u=document.querySelector(".bar input").value;if(!u)return;fetch("/apps/lattice/bookmark?url="+encodeURIComponent(u)+"&title="+encodeURIComponent(u),{method:"POST"}).then(function(r){if(r.ok){b.innerHTML="&#9733;";b.title="Bookmarked"}})};fetch("/apps/lattice/bookmarks").then(function(r){return r.ok?r.json():null}).then(function(j){var cu=document.querySelector(".bar input").value;if(!cu||!j)return;if((j.items||[]).some(function(it){return it.url===cu})){b.innerHTML="&#9733;";b.title="Bookmarked"}}).catch(function(x){})})();</script>'
    (page-sse-script keep rev)  nav-script  page-cache-script  sw-register-script  "</body></html>"
  ==
::  +beacon-rev-tape: the current /beacon/rev value, rendered as the same
::  text the keep-SSE stream sends in its event data. Baked into live pages
::  so their beacon script can tell a CACHED paint apart from a fresh one:
::  the stream's initial `old` event carries the rev as of connect, and a
::  mismatch against the baked value means the document predates a change —
::  +page-cache-script then refreshes the cached copy QUIETLY (the stale
::  paint stands; the next view is fresh), falling back to a reload where
::  the cache regime is unavailable. "" (never bumped, or peek failure)
::  disables the comparison.
::
++  beacon-rev-tape
  =/  m  (fiber:fiber:nexus ,tape)
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  ;<  v=view:nexus  bind:m
    (peek:io (rf up /beacon %rev) ~)
  ?.  ?=([%file *] v)  (pure:m "")
  =/  j=json  (fall (mole |.(;;(json (sang-noun:tarball sang.v)))) ~)
  ?~  j  (pure:m "")
  (pure:m (trip (en:json:html j)))
::  +keep-url: grubbery's native keep-SSE endpoint for one of our grubs.
::
++  keep-url
  |=  sub=tape
  ^-  tape
  (weld "/grubbery/api/keep/apps/lattice.lattice_app/" sub)
::  +sse-script: reactive live-view client JS. Streams grubbery's keep-SSE
::  for `keep`, acting only on " /rev" events (the stream carries the whole
::  /beacon directory). The initial `old` event's rev mismatching the baked
::  REV means this paint came from the pages cache stale: refresh that cache
::  quietly (next view is fresh; reload fallback without the cache regime).
::  A later `upd` is a live edit under the user's eyes: force-refresh the
::  cache — coalescing bumps that land mid-refresh — then swap to the
::  canonical URL, which sw-js serves from the copy just written (instant).
::  "" -> no script (remote pages, error shells). Built from single-quote
::  cords so the JS braces stay literal (only \\ needs escaping); mirrors
::  counter.hoon's SSE parse loop.
::
++  sse-script
  |=  [keep=tape rev=tape]
  ^-  tape
  ?~  keep  ""
  ;:  weld
    (trip '<script>(function(){var K="')
    keep
    (trip '";var REV="')
    rev
    %-  trip
    '";var pend=0,ac=null,live=false;function upd(){pend++;if(pend===1){(function go(){var n=pend;window.__latRefresh(true).then(function(ok){if(pend>n){setTimeout(go,1500);return}if(ok&&ok.chg&&window.__latCanon){pend=0;location.replace(window.__latCanon);return}if(!ok){location.reload();return}pend=0})})()}}async function c(){if(live||document.hidden)return;live=true;ac=new AbortController();try{var r=await fetch(K,{headers:{Accept:"text/event-stream"},signal:ac.signal});if(r.redirected||r.url.indexOf("/~/login")>=0)return;var R=r.body.getReader();var d=new TextDecoder();var b="";while(true){var x=await R.read();if(x.done)break;b+=d.decode(x.value,{stream:true});var ps=b.split("\\n\\n");b=ps.pop();for(var i=0;i<ps.length;i++){if(!ps[i].trim())continue;var ev="",dt="";var ls=ps[i].split("\\n");for(var j=0;j<ls.length;j++){if(ls[j].indexOf("event: ")===0)ev=ls[j].slice(7);else if(ls[j].indexOf("data: ")===0)dt=ls[j].slice(6)}if(!ev)continue;if(ev.slice(-5)!==" /rev")continue;if(ev.slice(0,3)==="old"){if(REV&&dt&&dt.trim()!==REV){if(window.__latRefresh){window.__latRefresh()}else{location.reload();return}}continue}if(window.__latRefresh){if(!document.hidden)upd();continue}location.reload();return}}}catch(x){}live=false;if(!document.hidden)setTimeout(c,3000)}document.addEventListener("visibilitychange",function(){if(document.hidden){if(ac)ac.abort();return}if(window.__latRefresh)upd();setTimeout(c,200)});c()})();</script>'
  ==
::  +send-public-how: whitelist <root>/pub in the grubbery `public` usergroup's
::  peek set, so any foreign ship may peek/keep published pages. UNION, never
::  overwrite. The public group is global (shared by every grubbery app), so we
::  add our road without clobbering others'. know/ is private by omission
::  (foreign access is deny-by-default, see the weir audit). Idempotent. Re-runs
::  on every writer (re)start, no-ops once our road is present. Skips quietly if
::  no public group exists yet (no peer has ever connected). It re-applies the
::  next time the writer starts after a peer shows up.
::
::  +exists-soft: peek-exists, but a VETO answers no instead of killing
::  the fiber. +peek-soft handles [~ %veto *] with [%done ~]; the hard
::  peek does not, and the writer is not a fiber that may die - a crashed
::  sig fiber respawns, so one refused road is a crash loop.
::
::  This is what makes the usergroup road OPTIONAL rather than required.
::  An install not granted it keeps every local feature and loses only
::  cross-ship publishing, which is the degradation weir.json's copy
::  promises. Ported from auspex, which found it the hard way: the road was
::  declared as a poke only, the peek was refused, and the writer
::  crash-looped on a road the arm already knew how to do without.
::
++  exists-soft
  |=  =road:tarball
  =/  m  (fiber:fiber:nexus ,?)
  ^-  form:m
  ;<  vw=(unit view:nexus)  bind:m  (peek-soft:io road ~)
  ?~  vw  (pure:m %.n)
  (pure:m !?=(?(%none %miss %veto %tomb) -.u.vw))
::
++  send-public-how
  |=  root=@ud
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  =/  gdir=road:tarball  [%& %| public-grp]
  ;<  ok=?  bind:m  (exists-soft gdir)
  ?.  ok  ~&([%lattice-no-public-group ~] (pure:m ~))
  ::  THE SANCTIONED PATH. Group weirs belong to grubbery's usergroup
  ::  machinery: a grant lands through the registry's %how action, which
  ::  validates the roads against the sender's registered prefix, merges
  ::  them server-side (other apps' roads survive untouched), and
  ::  recomputes every peer ship's effective weir. A direct put-file to
  ::  how.weir does none of that on the current core. Measured on the dev
  ::  pier: the file write was issued every boot, drew no veto, changed
  ::  nothing, and every cross-ship /pub keep came back denied.
  ::
  ::  %how replaces this prefix's roads in the group wholesale, so the act
  ::  carries lattice's COMPLETE public road set every time: the /pub dir
  ::  (world-readable published pages), every shared or clearweb page's
  ::  data road, and the share/comment inbox pokes. Callers run in the
  ::  writer fiber, whose rail the registration names; the register is
  ::  idempotent. Deep walk, so nested shared pages are granted too.
  ;<  ~  bind:m  (reg-register-at:io writer-rail)
  =/  pubdir=road:tarball  (rv root /pub)
  =/  pokes=(set road:tarball)
    %-  silt
    :~  `road:tarball`(rf up / %'shares.sig')
        `road:tarball`(rf up / %'comments.sig')
    ==
  ;<  sn=view:nexus  bind:m  (peek:io (rv root /page) ~)
  =/  rels=(list path)
    ?.  ?=([%ball *] sn)  ~
    %+  murn  (collect-tree ball.sn ~)
    |=([pax=path page=?] ?:(page `pax ~))
  =|  peeks=(set road:tarball)
  |-
  ?~  rels
    (reg-how:io /public [make=~ poke=pokes peek=(~(put in peeks) pubdir)])
  =/  pp=path  (weld /page i.rels)
  ;<  mode=share-mode:le  bind:m  (read-share pp)
  =?  peeks  !=(%private mode)  (~(put in peeks) (rf up pp %data))
  $(rels t.rels)
::  +apply: dispatch one knowledge action. root is the nexus dir (/lattice).
::
++  apply
  |=  [root=@ud now=@da act=know-action:lk]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  =/  vbase=path  /know/vault
  ::  trash-vault: deleted entry grubs MOVE here (not culled) so restore is a
  ::  plain move-back (robust, no born-history/cass recovery). /know/trash is the
  ::  derived metadata index over it.
  =/  tvbase=path  /know/trash-vault
  =/  tx=road:tarball  (rf root /know %trash)
  ?-    -.act
      %save
    ::  guard the key parse: a bad imported key (space, uppercase, no leading /)
    ::  would crash this single writer fiber, and rise-wait would then swallow the
    ::  NEXT mutation as a strange-restart. know-key mule-guards the stab. skip+log
    ::  instead of crashing. The route also pre-validates, so this is belt-and-braces.
    =/  ko=(unit path)  (know-key key.act)
    ?~  ko  ~&([%lattice-import-bad-key key.act] (pure:m ~))
    =/  key=path  u.ko
    ::  a bodyless %save must not silently blank an existing note (merge-save keeps
    ::  the tags but wipes the body). The /know-save route guards this; guard it here
    ::  too so the direct know-action poke can't bypass it. skip+log, like a bad key.
    ?:  =('' body.act)  ~&([%lattice-save-empty-body key] (pure:m ~))
    =/  road=road:tarball  (entry-road up vbase key)
    ;<  old=(unit know-entry:lk)  bind:m  (read-entry road)
    ::  reviving a soft-deleted key: %del culled the live grub, so `old` is ~ and
    ::  a fresh merge-save would drop the tags+vector the trashed copy still holds.
    ::  Read the trash-vault entry too and fall back to it, so a re-save recovers
    ::  them (the trash tomb is then cleared below, as for any re-save).
    ;<  tomb=(unit know-entry:lk)  bind:m  (read-entry (entry-road up tvbase key))
    =/  e=know-entry:lk  (merge-save:lk ?^(old old tomb) body.act now)
    ;<  ~  bind:m  (ensure-dirs vbase key)
    ;<  ~  bind:m  (put-file road [/lattice %know-entry] e)
    ;<  ~  bind:m  (gain:io road %.y)
    ::  memories are gained too, and autosave saves one revision per typing
    ::  pause, the same ceiling pages get, or the vault grows forever.
    ::  know entries are a user-facing history surface too, so same window
    ;<  ~  bind:m  (prune-hist road know-keep history-window)
    ::  a re-saved key leaves trash; cull the orphaned trash-vault GRUB (not just
    ::  the index row) so a later %restore can't resurrect the stale tomb over the
    ::  live entry.
    ;<  trash=know-index:lk  bind:m  (read-index tx)
    ?.  (~(has by trash) key)  (pure:m ~)
    ;<  *  bind:m  (cull-soft:io (entry-road up tvbase key))
    (put-file tx [/lattice %know-index] (~(del by trash) key))
  ::
      %del
    ::  guard the key parse: a bad imported key (space, uppercase, no leading /)
    ::  would crash this single writer fiber, and rise-wait would then swallow the
    ::  NEXT mutation as a strange-restart. know-key mule-guards the stab. skip+log
    ::  instead of crashing. The route also pre-validates, so this is belt-and-braces.
    =/  ko=(unit path)  (know-key key.act)
    ?~  ko  ~&([%lattice-import-bad-key key.act] (pure:m ~))
    =/  key=path  u.ko
    =/  road=road:tarball  (entry-road up vbase key)
    =/  troad=road:tarball  (entry-road up tvbase key)
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
    ::  poke API (mar know-action), bypassing the route's know-key check. A bad
    ::  key would crash+park the single writer and swallow the next mutation.
    =/  fko=(unit path)  (know-key from.act)
    =/  tko=(unit path)  (know-key to.act)
    ?~  fko  ~&([%lattice-move-bad-key from.act] (pure:m ~))
    ?~  tko  ~&([%lattice-move-bad-key to.act] (pure:m ~))
    =/  fk=path  u.fko
    =/  tk=path  u.tko
    =/  froad=road:tarball  (entry-road up vbase fk)
    =/  troad=road:tarball  (entry-road up vbase tk)
    ;<  old=(unit know-entry:lk)  bind:m  (read-entry froad)
    ?~  old  ~&([%lattice-move-missing fk] (pure:m ~))
    ::  refuse to clobber a LIVE target (the route pre-checks and 409s. This is
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
    ;<  *  bind:m  (cull-soft:io (entry-road up tvbase tk))
    (put-file tx [/lattice %know-index] (~(del by trash) tk))
  ::
      %restore
    ::  guard the key parse: a bad imported key (space, uppercase, no leading /)
    ::  would crash this single writer fiber, and rise-wait would then swallow the
    ::  NEXT mutation as a strange-restart. know-key mule-guards the stab. skip+log
    ::  instead of crashing. The route also pre-validates, so this is belt-and-braces.
    =/  ko=(unit path)  (know-key key.act)
    ?~  ko  ~&([%lattice-import-bad-key key.act] (pure:m ~))
    =/  key=path  u.ko
    =/  road=road:tarball  (entry-road up vbase key)
    =/  troad=road:tarball  (entry-road up tvbase key)
    ;<  old=(unit know-entry:lk)  bind:m  (read-entry troad)
    ?~  old  ~&([%lattice-restore-missing key] (pure:m ~))
    ::  refuse to resurrect over a LIVE entry. The save/move/import writers already
    ::  cull the trash grub when a key goes live again, so this can't normally fire.
    ::  It's the last guard against a stale tomb clobbering live data.
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
    ::  write a live entry VERBATIM (preserve updated/tags/vector). An import,
    ::  not a user edit, so no merge-save now-stamp. Mirror of %save minus the
    ::  body merge. index row derives from the entry's own metadata.
    ::  guard the key parse: a bad imported key (space, uppercase, no leading /)
    ::  would crash this single writer fiber, and rise-wait would then swallow the
    ::  NEXT mutation as a strange-restart. know-key mule-guards the stab. skip+log
    ::  instead of crashing. The route also pre-validates, so this is belt-and-braces.
    =/  ko=(unit path)  (know-key key.act)
    ?~  ko  ~&([%lattice-import-bad-key key.act] (pure:m ~))
    =/  key=path  u.ko
    =/  road=road:tarball  (entry-road up vbase key)
    ;<  ~  bind:m  (ensure-dirs vbase key)
    ;<  ~  bind:m  (put-file road [/lattice %know-entry] entry.act)
    ;<  ~  bind:m  (gain:io road %.y)
    ;<  trash=know-index:lk  bind:m  (read-index tx)
    ?.  (~(has by trash) key)  (pure:m ~)
    ;<  *  bind:m  (cull-soft:io (entry-road up tvbase key))
    (put-file tx [/lattice %know-index] (~(del by trash) key))
  ::
      %import-trashed
    ::  land a trashed entry straight into the trash vault (import of an
    ::  already-deleted entry). No live grub, no cull dance, just write + index.
    ::  guard the key parse: a bad imported key (space, uppercase, no leading /)
    ::  would crash this single writer fiber, and rise-wait would then swallow the
    ::  NEXT mutation as a strange-restart. know-key mule-guards the stab. skip+log
    ::  instead of crashing. The route also pre-validates, so this is belt-and-braces.
    =/  ko=(unit path)  (know-key key.act)
    ?~  ko  ~&([%lattice-import-bad-key key.act] (pure:m ~))
    =/  key=path  u.ko
    =/  troad=road:tarball  (entry-road up tvbase key)
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
  |=  [root=@ud now=@da act=pub-action:lp]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  =/  vbase=path  /pub/vault
  =/  px=road:tarball  (rf root /pub %index)
  ?-    -.act
      %save-page
    ::  guard the key parse: a bad imported key (space, uppercase, no leading /)
    ::  would crash this single writer fiber, and rise-wait would then swallow the
    ::  NEXT mutation as a strange-restart. know-key mule-guards the stab. skip+log
    ::  instead of crashing. The route also pre-validates, so this is belt-and-braces.
    =/  ko=(unit path)  (know-key key.act)
    ?~  ko  ~&([%lattice-import-bad-key key.act] (pure:m ~))
    =/  key=path  u.ko
    ::  a top-level single-char pub name would shadow a urb:// mount letter
    ::  (p/n/k/t and the rest of the reserved 1-char space), so its bare
    ::  canonical url could never resolve back to it. Refuse it. The whole
    ::  single-char first-component space stays reserved to the protocol forever.
    ?:  ?&(?=([@ ~] key) =(1 (met 3 i.key)))
      ~&([%lattice-pub-name-reserved key] (pure:m ~))
    =/  or=(unit vrail:lp)  (key-to-rail:lp vbase key)
    ?~  or  ~&([%lattice-pub-bad-key key] (pure:m ~))
    =/  road=road:tarball  (rf up pax.u.or nom.u.or)
    ;<  ~  bind:m  (ensure-dirs vbase (slag (lent vbase) pax.u.or))
    ::  the rev bound in the namespace by the PREVIOUS publish of this page,
    ::  read BEFORE this save's put-file bumps the vault grub's cass. This is
    ::  the exact predecessor spur the keep-only-current cull below retracts.
    ::  The last save grew a body at this cass, or, on a re-save after delete,
    ::  the delete grew its TOMBSTONE at this cass. A tombed grub does NOT
    ::  drop out of the dir wave. born is a high-water mark, so it reads the
    ::  [%temp ~] cass the cull appended, which is exactly where %del-page
    ::  bound the tombstone. 0 only when the page has never been published.
    ;<  prev-rev=@ud  bind:m  (pub-grub-rev pax.u.or nom.u.or)
    ;<  ~  bind:m  (put-file road [/lattice %page] body.act)
    ;<  ~  bind:m  (gain:io road %.y)
    ;<  ix=pub-index:lp  bind:m  (read-pub-index px)
    =/  nix=pub-index:lp  (~(put by ix) key (to-pub-row:lp body.act now))
    ;<  ~  bind:m  (put-file px [/lattice %pub-index] nix)
    ::  mesa (D1): mirror the publish into the remote-scry namespace, so a
    ::  peer can %keen the page instead of negotiating a grubbery peek. Two
    ::  bindings: the body at /pub/page/<name>/<rev> (rev = the vault grub's
    ::  cass, read AFTER the put-file so it names the revision just written),
    ::  and a fresh /pub/index/<seq> manifest. %grow is fire-and-forget, so a
    ::  crash between the vault write and the grow can leave the namespace one
    ::  save behind. POST /pub-regrow re-grows the current state.
    ;<  rev=@ud  bind:m  (pub-grub-rev pax.u.or nom.u.or)
    ::  ORDERING (mesa D2): the subscriber's wave carries this cass, and gall
    ::  PARKS a keen at an unbound spur. That is the documented remote-scry
    ::  deficiency, a hang rather than an error. The put-file above already
    ::  emitted the wave card, but ames transmission is orders slower than
    ::  local card application (and the reader retries once), so growing here
    ::  binds the rev well before any keen can arrive.
    ;<  ~  bind:m  (grow-pub-page key body.act rev)
    ::  keep-only-current INVARIANT: at most one rev spur per page is ever
    ::  bound. Retract the PREDECESSOR rev spur now that the new one is
    ::  grown. Grow-then-cull, in this order, so a reader never observes zero
    ::  bindings for the page. Guards:
    ::    prev-rev=0        no prior publish, nothing to cull
    ::    prev-rev=rev      a no-op save (save-file suppressed the cass
    ::                      bump). The "predecessor" IS the current spur,
    ::                      so do not cull.
    ::  The predecessor was grown by the previous save and not yet culled, so
    ::  this hits a still-bound spur exactly once. The sharp edge on a
    ::  re-cull is not gall (+ap-cull no-ops totally) but +farm-top's %gw
    ::  lookup, which crashes on the emptied plot a previous cull left. See
    ::  +cull-farm:io. A pre-mesa page whose old rev was never grown culls
    ::  as a no-op (farm-top finds nothing listed).
    =/  inner=path  (snip (strip-pub:lp key))
    ;<  ~  bind:m
      ?:  |(=(0 prev-rev) =(prev-rev rev))  (pure:m ~)
      (cull-farm:io (snoc (weld /pub/page inner) (scot %ud prev-rev)))
    ;<  *  bind:m  (grow-pub-index root nix)
    (pure:m ~)
  ::
      %del-page
    ::  guard the key parse: a bad imported key (space, uppercase, no leading /)
    ::  would crash this single writer fiber, and rise-wait would then swallow the
    ::  NEXT mutation as a strange-restart. know-key mule-guards the stab. skip+log
    ::  instead of crashing. The route also pre-validates, so this is belt-and-braces.
    =/  ko=(unit path)  (know-key key.act)
    ?~  ko  ~&([%lattice-import-bad-key key.act] (pure:m ~))
    =/  key=path  u.ko
    =/  or=(unit vrail:lp)  (key-to-rail:lp vbase key)
    ?~  or  ~&([%lattice-pub-bad-key key] (pure:m ~))
    =/  road=road:tarball  (rf up pax.u.or nom.u.or)
    ;<  exists=?  bind:m  (peek-exists:io road)
    ?.  exists
      ::  FOLDER delete/move: the key names no gmi grub of its own. The eval
      ::  %del arm hands the FOLDER's key here, and +move-pages ends every
      ::  move with that same %del. Each contained page holds its own index
      ::  row and namespace bindings. The vault-side cull-soft takes the
      ::  subtree, but nothing else retracts the pub bindings, which would
      ::  leave every contained page world-readable forever. Recurse the
      ::  delete over every live index key under the folder prefix. Each
      ::  child is a plain page delete. A truly missing page (no children
      ::  either) stays a no-op.
      ;<  ix=pub-index:lp  bind:m  (read-pub-index px)
      =/  pre=path  (snip key)
      =/  kids=(list path)
        %+  skim  ~(tap in ~(key by ix))
        |=  k=path
        &(!=(k key) =(pre (scag (lent pre) k)))
      ?~  kids  ~&([%lattice-pub-del-missing key] (pure:m ~))
      =/  todo=(list path)  kids
      |-
      ?~  todo  (pure:m ~)
      ;<  ~  bind:m  (apply-pub root now [%del-page (spat i.todo)])
      $(todo t.todo)
    ::  the latest published rev, read BEFORE the vault cull appends its
    ::  [%temp ~] hist entry. It names the body binding the cull-farm below
    ::  retracts.
    ;<  rev=@ud  bind:m  (pub-grub-rev pax.u.or nom.u.or)
    ::  cull tombs the grub (gain=%.y keeps the body in born history). Drop its
    ::  index row so it's no longer live. No trash row. Pages have no restore.
    ;<  ~  bind:m  (cull:io road)
    ::  DELETE TOMBSTONE (mesa D2): the subscriber's wave reads the
    ::  post-cull cass. born is a high-water mark, so the grub never drops
    ::  out of the wave's file map and an absent cass can never signal a
    ::  delete. Grow a [%del ''] binding at exactly that cass, so the
    ::  subscriber's keen at the wave's rev HITS a tombstone instead of
    ::  parking on an unbound spur, and the delete propagates over the same
    ::  wave->keen path as a save. The next re-save culls this spur as its
    ::  ordinary predecessor (see %save-page's prev-rev). A reader without
    ::  the tombstone protocol ignores the unknown mark, so there is no flag
    ::  day. The vault cull's own wave leaves as a card ahead of this grow's,
    ::  but ames transmission is orders slower than local card application
    ::  (and the reader retries once after ~s2), so the binding is live well
    ::  before any keen can arrive.
    ;<  post=@ud  bind:m  (pub-grub-rev pax.u.or nom.u.or)
    =/  inner=path  (snip (strip-pub:lp key))
    ;<  ~  bind:m
      ?:  =(post rev)  (pure:m ~)
      (grow:io (snoc (weld /pub/page inner) (scot %ud post)) [%del ''])
    ;<  ix=pub-index:lp  bind:m  (read-pub-index px)
    =/  nix=pub-index:lp  (~(del by ix) key)
    ;<  ~  bind:m  (put-file px [/lattice %pub-index] nix)
    ::  mesa (D1): retract the namespace copy. cull-farm, NOT tomb, and the
    ::  difference is the whole point. %tomb is per-[case spur] and gall's
    ::  +ap-tomb replaces exactly ONE case's value with its hash, while
    ::  +ap-cull deletes every case at or below the one it is given and parks
    ::  that number as the spur's high-water mark, so nothing re-binds under
    ::  it. cull-farm:io asks for the whole spur. grubbery resolves the top
    ::  bound case for us (the kernel no-ops a cull outside the bound range,
    ::  so "all of them" is not a number a caller can pick).
    ::
    ::  Measured on ~tyr, which is why this is not a stylistic preference. A
    ::  save grows the rev spur at case 1, but every later POST /pub-regrow
    ::  re-grows that SAME spur and gall's +grow assigns key+1 each time, so a
    ::  page saved once and regrown twice answers at cases 1, 2 AND 3, all
    ::  carrying the same body. Reads are unaffected (case 1 is always present
    ::  and always the same page). Deletes are not. A per-case tomb of case 1
    ::  would leave a peer that keened case 2 still reading the deleted page,
    ::  the #178 failure again one layer down.
    ::
    ::  The peek-exists guard at the top of this branch is load-bearing for
    ::  this call, not just a nicety. cull-farm must not run twice on the
    ::  same spur. +farm-top's %gw lookup crashes on the emptied plot the
    ::  first cull left (gall's own +ap-cull would have no-opped), and that
    ::  guard is what makes a repeat delete exit before it gets here.
    ::
    ::  Culling the LATEST rev's spur is SUFFICIENT, not a leak. +apply-pub
    ::  keeps the keep-only-current invariant (every save culls its predecessor
    ::  rev spur), so the current rev is the ONLY page binding ever live and no
    ::  historical rev survives a delete. gall's scry farm only shrinks via an
    ::  agent's own %tomb/%cull. Nothing reaps a bound spur on its own, so any
    ::  un-culled rev would stay world-readable via keen forever.
    ::  The successor index seq is grown, and the predecessor seq culled inside
    ::  +grow-pub-index, so followers see the page leave the manifest and no
    ::  stale seq lingers.
    ;<  ~  bind:m  (cull-farm:io (snoc (weld /pub/page inner) (scot %ud rev)))
    ;<  *  bind:m  (grow-pub-index root nix)
    (pure:m ~)
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
::  ── mesa: the remote-scry publish mirror (docs D1) ───────────────────────
::  Every pub-vault save/delete ALSO drives the ship's remote-scry namespace,
::  so a peer can read pages with %keen (content-addressed, kernel-cached)
::  instead of negotiating grubbery peeks. The scheme:
::    /pub/page/<name-segments>/<rev>   one immutable binding per published
::                                      body ([%gmi @t], rev = the vault
::                                      grub's cass), or the [%del '']
::                                      TOMBSTONE a delete grows at its
::                                      post-cull cass, so subscribers learn
::                                      the delete over the same wave->keen
::                                      path as a save
::    /pub/index/<seq>                  the discovery manifest (manifest-gmi),
::                                      re-grown on every publish and delete
::    [/pub %meta] grub                 the seq counter, monotonic @ud
::  Bindings are immutable per spur (the rev/seq segment makes each grow
::  fresh), which is what the namespace requires. Rev discovery rides the
::  page keep's own wave (see /sub/pages). There is no pointer grub. Compiles
::  only against grubbery feat/scry-io (grow:io / cull-farm:io / keen:io).
::
::  +pub-grub-rev: the current cass revision of one pub-vault grub, 0 if
::  absent. Same one-dir-peek read +page-rev uses (the wave carries the cass),
::  aimed at the vault grub instead of a /page code grub.
::
++  pub-grub-rev
  |=  [pax=path nom=@ta]
  =/  m  (fiber:fiber:nexus ,@ud)
  ^-  form:m
  ;<  dv=view:nexus  bind:m  (peek:io [%& %| pax] ~)
  ?.  ?=([%ball *] dv)  (pure:m 0)
  =/  wfil=(map @ta cass:clay)  ?~(fil.wave.dv ~ file.u.fil.wave.dv)
  =/  c=(unit cass:clay)  (~(get by wfil) nom)
  (pure:m ?~(c 0 ud.u.c))
::  +read-pub-seq: the [/pub %meta] publish counter. 0 if the grub is missing
::  or predates the row (mirror of read-pub-index's absent case).
::
::  Read through +sang-noun, NOT +need-vase. A grub whose mark fails to vale
::  is stored as a boom ([tang noun], no vase), and need-vase crashes on a
::  boom, which would kill every fiber that touches the publish path (the
::  single writer, and POST /pub-regrow's request fiber). sang-noun reads
::  the atom out of EITHER shape, so a pier still carrying a boomed counter
::  recovers its real seq instead of restarting at 0, and the next
::  +grow-pub-index write re-lays it under a mark that vales.
::
::  Unlike +read-pub-index this may safely soften to a default. A lost counter
::  re-grows an already-bound seq (stale but readable, per +grow-pub-index),
::  whereas a softened index would silently overwrite the live index with ~.
::
++  read-pub-seq
  |=  road=road:tarball
  =/  m  (fiber:fiber:nexus ,@ud)
  ^-  form:m
  ;<  seen=view:nexus  bind:m  (peek:io road ~)
  ?.  ?=([%file *] seen)  (pure:m 0)
  (pure:m (fall (mole |.(;;(@ud (sang-noun:tarball sang.seen)))) 0))
::  +grow-pub-page: bind one page body in the namespace at its rev spur.
::  key is the canonical pub key (/pub/<name…>/gmi, already validated by the
::  caller's key-to-rail). The spur drops the pub/gmi wrapping and rides the
::  rev as its last segment, so every revision is its own immutable binding.
::  The page rides the %gmi mark. The vault body IS rendered gemtext.
::
++  grow-pub-page
  |=  [key=path body=@t rev=@ud]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  =/  inner=path  (snip (strip-pub:lp key))
  (grow:io (snoc (weld /pub/page inner) (scot %ud rev)) [%gmi body])
::  +grow-pub-index: grow the successor discovery manifest. Reads the seq
::  counter, grows /pub/index/<seq+1> carrying manifest-gmi of the index the
::  caller JUST wrote, then persists the bumped counter. Counter write comes
::  last. A crash before it re-grows the same seq next publish, and gall
::  treats a re-grow of a bound spur as a fresh case (stale but readable),
::  where the reverse order could skip a seq forever.
::
::  Returns the seq it grew. Nothing consumes it. Callers discard it.
::
++  grow-pub-index
  |=  [root=@ud ix=pub-index:lp]
  =/  m  (fiber:fiber:nexus ,@ud)
  ^-  form:m
  =/  mx=road:tarball  (rf root /pub %meta)
  ;<  seq=@ud  bind:m  (read-pub-seq mx)
  =/  nseq=@ud  +(seq)
  ;<  ~  bind:m  (grow:io /pub/index/[(scot %ud nseq)] [%gmi (manifest-gmi ix)])
  ::  keep-only-current INVARIANT for the manifest: at most one /pub/index seq
  ::  is ever bound. Retract the predecessor seq now that the successor is
  ::  grown. Grow-then-cull, so a reader never sees zero manifests. seq
  ::  (= nseq-1) is the predecessor. On the very first publish seq=0 and
  ::  /pub/index/0 was never grown, so this culls as a no-op (farm-top finds
  ::  nothing bound there, the same safety the below-current sweep relies on).
  ::  Otherwise the counter is strictly monotonic (+1 per grow), so every seq
  ::  is grown once and culled once here. A still-bound spur is hit exactly
  ::  once and never re-culled (which cull-farm cannot survive). +read-pub-seq's
  ::  boom-recovery keeps the counter alive so a lost counter can't re-grow a
  ::  live seq and break that. Runs on save, delete AND regrow, so every
  ::  manifest grow maintains the one-live-seq rule.
  ;<  ~  bind:m  (cull-farm:io /pub/index/[(scot %ud seq)])
  ::  [/ %ud], grubbery's own atom mark (see the /pub/meta covering row in
  ::  +on-load). A put-file under a mark with no source file lays a boom.
  ;<  ~  bind:m  (put-file mx [/ %ud] nseq)
  (pure:m nseq)
::  +pub-regrow: backfill the namespace from the existing pub vault, every
::  page at its CURRENT vault rev, then one fresh index seq. For piers that
::  published before the mesa mirror existed (their saves never grew). Same
::  walk the manifest generation uses: the pub index's key set, each key read
::  through its vault rail. Returns the number of pages grown.
::
::  Single pass, not chunked. Per page it costs one file peek, one dir peek and
::  one fire-and-forget %grow card, so even a large vault is one event of cheap
::  local darts. If a regrow is ever observed to brown out the pier, ack the
::  request first, sleep a second so the effects flush, then walk the vault.
::
::  Re-running it is cheap but not free. A %grow at an already-bound spur does
::  not overwrite but appends a case (gall's +grow takes key+1). The body is
::  identical so no read changes, and %del-page's cull-farm retracts the whole
::  spur however many cases deep it went. The extra cases are wasted farm
::  space, nothing more.
::
++  pub-regrow
  =/  m  (fiber:fiber:nexus ,@ud)
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  ::  Grants live in the registry-canonical %how act, laid at writer boot
  ::  (+send-public-how). The regrow route runs in a request fiber, whose
  ::  rail the registry does not know, so grant repair belongs to a writer
  ::  restart and this route only rebuilds namespace bindings.
  ;<  ix=pub-index:lp  bind:m
    (read-pub-index (rf up /pub %index))
  ;<  n=@ud  bind:m  (pub-regrow-loop ~(tap in ~(key by ix)) 0)
  ::  the seq advances like any publish. Subscribers do no seq bookkeeping
  ::  (the rev rides each page keep's own wave), so a regrow is invisible to
  ::  them until a page's next real edit wave.
  ;<  *  bind:m  (grow-pub-index up ix)
  (pure:m n)
++  pub-regrow-loop
  |=  [keys=(list path) cnt=@ud]
  =/  m  (fiber:fiber:nexus ,@ud)
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  ?~  keys  (pure:m cnt)
  =/  or=(unit vrail:lp)  (key-to-rail:lp /pub/vault i.keys)
  ?~  or  (pub-regrow-loop t.keys cnt)
  ;<  seen=view:nexus  bind:m  (peek:io (rf up pax.u.or nom.u.or) ~)
  ?.  ?=([%file *] seen)  (pub-regrow-loop t.keys cnt)
  ::  clam in a mole. One malformed grub (an index row whose vault copy was
  ::  hand-edited) must skip, not kill the whole backfill.
  =/  body=(unit @t)  (mole |.(!<(@t (need-vase:tarball sang.seen))))
  ?~  body  (pub-regrow-loop t.keys cnt)
  ;<  rev=@ud  bind:m  (pub-grub-rev pax.u.or nom.u.or)
  ;<  ~  bind:m  (grow-pub-page i.keys u.body rev)
  (pub-regrow-loop t.keys +(cnt))
::  +pub-reconcile: the ONE-SHOT leak cleanup behind POST /pub-reconcile.
::  Walks the ENTIRE pub-vault tree in one dir peek. The wave is a full
::  recursive axal, and born is a high-water mark, so DELETED (tombed) grubs
::  are enumerated right alongside live ones. For every gmi grub it reads
::  the full version history (born:io) and cull-farms every rev spur BELOW
::  the current one, then culls every index seq below the live counter.
::  Each past live cass is a rev a pre-fix save grew into the namespace and
::  never culled. What survives is exactly the one live binding per page (a
::  body, or a delete tombstone) and the one live index seq, the steady
::  state +apply-pub maintains going forward. Walking the vault instead of
::  the live index is the point. A page published several times and then
::  DELETED is absent from the index, but its superseded revs, the most
::  sensitive leaked class, are still enumerated and retracted here. Its
::  final rev was already culled by the delete itself, and the skim below
::  skips it.
::
::  STRICTLY one-shot, enforced by the [/pub %reconciled] marker grub. A
::  second POST 409s. gall's +ap-cull itself is total (missing plot,
::  emptied plot and out-of-range case are all traced no-ops in gall.hoon
::  +ap-cull), but grubbery's +farm-top LOOKUP %gw-scries any spur the %gt
::  listing carries, and gall answers %gw on an EMPTIED plot with [~ ~],
::  which +mink turns into an unsoftenable crash. So a run that targets a
::  spur something already culled (a re-run, or a post-fix save's
::  predecessor cull) takes the request event down. Nothing is lost (the
::  event rolls back atomically), but the sweep never completes. Two rules
::  follow, both the caller's responsibility: run it ONCE, and run it
::  RIGHT AFTER deploying the leak fix, before any post-fix publish/delete
::  has culled anything. The marker enforces once. Ordering is on the
::  operator. A pier that deploys the finished overlay onto an empty farm
::  (the production case) has nothing to reconcile. This arm exists for
::  piers that ran the intermediate leaky commits.
::
::  GAP: enumeration is bounded by born history. A rev whose history entry
::  was pruned under a keep ceiling grew a spur this cannot name and so
::  cannot retract. That spur stays leaked. There is no farm listing a
::  nexus fiber can fall back on (%gt/%gw are the agent's own gall scries),
::  so born history is the whole enumeration. The report says so plainly.
::
++  pub-reconcile
  =/  m  (fiber:fiber:nexus ,(unit [revs=@ud seqs=@ud]))
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  =/  markr=road:tarball  (rf up /pub %reconciled)
  ;<  done=?  bind:m  (peek-exists:io markr)
  ?:  done  (pure:m ~)
  ;<  dv=view:nexus  bind:m  (peek:io (rv up /pub/vault) ~)
  =/  grubs=(list [segs=path nom=@ta])
    ?.  ?=([%ball *] dv)  ~
    (wave-grubs wave.dv)
  ;<  rc=@ud  bind:m  (pub-reconcile-revs /pub/vault grubs 0)
  ;<  sc=@ud  bind:m  pub-reconcile-seqs
  ;<  now=@da  bind:m  bowl-now
  ;<  ~  bind:m  (put-file markr [/ %ud] `@ud`now)
  (pure:m `[rc sc])
::  +wave-grubs: every file in a dir wave's recursive axal, as
::  [path-under-the-peeked-dir file-name] pairs. Pure walk.
::
++  wave-grubs
  |=  wav=wave:nexus
  ^-  (list [segs=path nom=@ta])
  =|  here=path
  |-  ^-  (list [segs=path nom=@ta])
  %+  weld
    ^-  (list [segs=path nom=@ta])
    ?~  fil.wav  ~
    %+  turn  ~(tap by file.u.fil.wav)
    |=([nom=@ta *] [here nom])
  =/  kids=(list [nom=@ta kid=wave:nexus])  ~(tap by dir.wav)
  |-  ^-  (list [segs=path nom=@ta])
  ?~  kids  ~
  %+  weld
    ^$(wav kid.i.kids, here (snoc here nom.i.kids))
  $(kids t.kids)
::  +pub-reconcile-revs: cull the below-current rev spurs of every vault
::  grub, live or tombed.
::
++  pub-reconcile-revs
  |=  [vbase=path grubs=(list [segs=path nom=@ta]) cnt=@ud]
  =/  m  (fiber:fiber:nexus ,@ud)
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  ?~  grubs  (pure:m cnt)
  ::  only gmi grubs are pages. Nothing else was ever grown.
  ?.  =(%gmi nom.i.grubs)  (pub-reconcile-revs vbase t.grubs cnt)
  ;<  hs=(each (list [=cass:clay tags=(set @t) tomb=?]) tang)  bind:m
    (born:io (rf up (weld vbase segs.i.grubs) nom.i.grubs))
  ?:  ?=(%| -.hs)  (pub-reconcile-revs vbase t.grubs cnt)
  ::  the LIVE (non-tomb) rev numbers, one per content write, each of which
  ::  +grow-pub-page bound a spur for. The current grown spur is the MAX of
  ::  these. Deliberately NOT +pub-grub-rev. A move or delete tombs the vault
  ::  grub, advancing its cass WITHOUT growing a body spur, so pub-grub-rev
  ::  can name a rev no body was ever grown at. born's tomb flag skips those
  ::  bumps. For a DELETED page cur is the final body rev, which the delete
  ::  itself culled (and, when the delete grew a tombstone, whose successor
  ::  cass holds the [%del ''] binding). The skim keeps both out of the cull
  ::  list. born keeps NEWEST revisions under any keep ceiling, so the max
  ::  is reliable even when older content revs were pruned out. Those pruned
  ::  spurs are the enumeration GAP.
  =/  live=(list @ud)
    %+  murn  p.hs
    |=  [c=cass:clay tags=(set @t) tomb=?]
    ?:(tomb ~ `ud.c)
  ::  cur (the max live rev) is kept. Everything below it is a historical
  ::  grown spur to retract. No early ~-guard. An all-tomb grub yields cur=0
  ::  and an empty cull list, a harmless no-op, and narrowing `live` to a
  ::  lest here trips the wet inference in +max-ud/+skim.
  =/  cur=@ud  (max-ud live)
  =/  revs=(list @ud)  (skim live |=(r=@ud (lth r cur)))
  ;<  n=@ud  bind:m  (cull-rev-spurs segs.i.grubs revs 0)
  (pub-reconcile-revs vbase t.grubs (add cnt n))
::  +max-ud: the largest element of a rev list, 0 if empty.
::
++  max-ud
  |=  l=(list @ud)
  ^-  @ud
  ?~  l  0
  (max i.l $(l t.l))
::  +cull-rev-spurs: retract each named rev spur of one page.
::
++  cull-rev-spurs
  |=  [inner=path revs=(list @ud) cnt=@ud]
  =/  m  (fiber:fiber:nexus ,@ud)
  ^-  form:m
  ?~  revs  (pure:m cnt)
  ;<  ~  bind:m  (cull-farm:io (snoc (weld /pub/page inner) (scot %ud i.revs)))
  (cull-rev-spurs inner t.revs +(cnt))
::  +pub-reconcile-seqs: cull every index seq below the live counter.
::
++  pub-reconcile-seqs
  =/  m  (fiber:fiber:nexus ,@ud)
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  =/  mx=road:tarball  (rf up /pub %meta)
  ;<  cur=@ud  bind:m  (read-pub-seq mx)
  (cull-seq-spurs 1 cur 0)
::  +cull-seq-spurs: cull /pub/index/i for i in [lo, top). A never-grown seq
::  culls as a no-op (farm-top lists nothing), so a gap is harmless. Only an
::  already-culled seq would crash, which the one-shot marker guards against.
::
++  cull-seq-spurs
  |=  [i=@ud top=@ud cnt=@ud]
  =/  m  (fiber:fiber:nexus ,@ud)
  ^-  form:m
  ?:  (gte i top)  (pure:m cnt)
  ;<  ~  bind:m  (cull-farm:io /pub/index/[(scot %ud i)])
  (cull-seq-spurs +(i) top +(cnt))
::  ── mesa: scry-first cross-ship READS (docs D1, phase C) ─────────────────
::  The block above publishes OUR pages into the namespace. This block reads a
::  PEER's. A %keen is a content-addressed namespace read. The publisher's
::  kernel answers it out of gall's scry farm without waking %grubbery, with
::  no weir round-trip and no per-reader work, and the answer is signed so any
::  relay on the path may cache it. That is the whole point of the transport.
::
::  Scry-first is ALWAYS a fallback pair. Every arm here answers ~ on any
::  failure (deadline, unbound spur, wrong mark, malformed noun), and the
::  caller then runs today's grubbery peek unchanged. Nothing below can make a
::  read fail that would otherwise have succeeded. The worst case is one
::  wasted +mesa-timeout ahead of the peek that was going to run anyway.
::
::  Compiles only against grubbery feat/scry-io (keen:io / with-timeout:io).
::  NOTHING here has been exercised at runtime. A %keen is answered by another
::  ship's kernel, so it needs both A2 (feat/scry-io under the live agent) and
::  a second ship. Phase D.
::
::  +mesa-agent: the gall agent whose scry farm holds the bindings. lattice is
::  a NEXUS inside %grubbery, so +grow-pub-page's spurs live under %grubbery's
::  yoke, not under an agent named %lattice. A fiber cannot read its own `dap`
::  (bowl-our / bowl-now are the whole bowl surface), so this is a constant and
::  it must track the desk's agent name.
::
++  mesa-agent  ^-(@ta %grubbery)
::  +mesa-timeout: how long ONE %keen waits. keen:io carries no deadline of its
::  own (ames holds an unanswerable request forever), so this is the only
::  bound. Deliberately far under +remote-timeout (~s30). A namespace read is
::  answered from a cache or from the publisher's kernel with no agent in the
::  loop, so a keen that is slow is a keen that is not coming, and its cost is
::  paid ON TOP of the peek that then has to run.
::
++  mesa-timeout  ^-(@dr ~s10)
::  +keen-path: the ames scry path (the spar path) of one published page body.
::  MUST mirror +grow-pub-page's spur exactly or every read misses forever.
::
::    /g/x/1/<agent>//1/pub/page/<rel…>/<rev>
::      g          gall
::      x          the value care
::      1          the gall CASE. A rev-carrying spur is grown at case 1 by the
::                 save that created it, and every case gall later assigns to
::                 that spur (a /pub-regrow re-grow gets key+1) carries the
::                 SAME body. The rev in the spur is what makes the content
::                 immutable. So case 1 is always present and always right.
::      <agent>    q.bem, the yoke whose farm is read (see +mesa-agent)
::      ''         THE EMPTY SEGMENT, and it is load-bearing. The publisher's
::                 ames splits the spar into [ship rift life vane care case
::                 spur] and +as-omen:balk takes the HEAD of that spur as the
::                 beam's desk slot (the agent) and its TAIL as s.bem. gall's
::                 +scry then splits on that tail. `?. ?=([%$ *] path)` sends
::                 anything NOT starting with the empty knot to the agent's
::                 +on-peek instead of to the vane's scry farm. Verified on
::                 the live pier. A probe without this segment came back
::                 "unexpected scry into %grubbery on path /t/1/pub" (the
::                 agent's default-agent +on-peek), while the same read with
::                 it answered the grown page. Without it every keen would
::                 miss silently, because a fallback path treats a miss as
::                 normal.
::      1          the namespace version marker gall's +scry requires
::                 (?=([%'1' *] path) on the beam's path AFTER the split above)
::      pub/page/… the spur +grow-pub-page grew: /pub/page/<rel>/<rev>
::
::  ames prepends /<ship>/<rift>/<life> itself (+fi-full-path), so the spar
::  path starts at the vane letter. rel runs through +page-rel so a caller may
::  hand over either the vault-relative form or a /pub/<spur>/gmi content key,
::  exactly like +read-page-body tolerates.
::
::  Built by cons, not as a path literal. The empty segment is exactly the
::  thing a literal cannot spell unambiguously, and it is the one segment
::  nobody notices is missing.
::
++  keen-path
  |=  [rel=path rev=@ud]
  ^-  path
  %+  weld  `path`[%g %x %'1' mesa-agent %$ %'1' %pub %page ~]
  (snoc (page-rel rel) (scot %ud rev))
::  +keen-page-raw: read one page binding out of a PEER's namespace, mark and
::  all. `~ on every failure. The mark matters to the /sub reader. The mirror
::  grows [%gmi body] for a save and a [%del ''] tombstone for a delete, and
::  the subscriber acts on which one the keen returned.
::
::  On our own deadline firing, %yawn the request. ames otherwise holds an
::  unanswerable keen forever (a parked request per missed keen, growing
::  without bound on a reader whose publisher stopped mirroring).
::
::  +deadline: with-timeout, reimplemented here from primitives that every
::  grubbery in the fleet shares.
::
::  +with-timeout:io itself cannot be called portably. Its body is identical
::  across the versions our ships run, but its SIGNATURE is not: the newer one
::  takes a leading wire, the older one mints its own through +nonce. A source
::  file can only pick one, so calling it directly makes lattice buildable on
::  exactly one grubbery generation. That is not academic. It is what made the
::  obelisk mirror stage cleanly onto a production ship and then quietly fail
::  to compile there, leaving the old ball running and the deploy inert.
::
::  Everything used below (+nonce, +get-time, +set-timer, +cancel-timer, and
::  the shape of a fiber take) is present and identical in both, so this arm
::  builds anywhere and needs no per-ship variant.
::
++  deadline
  |*  result=mold
  =/  m   (fiber:fiber:nexus ,(unit result))
  =/  mr  (fiber:fiber:nexus ,result)
  |=  [time=@dr computation=form:mr]
  ^-  form:m
  ;<  =wire    bind:m  (nonce:io /keen-to)
  ;<  now=@da  bind:m  get-time:io
  ;<  ~        bind:m  (set-timer:io wire (add now time))
  |=  input:fiber:nexus
  ^-  output:m
  ::  our own deadline fired before the computation finished
  ?:  ?&  ?=([~ %poke * *] in)
          =([/ %timer-wake] p.sage.u.in)
          =(wire !<(^wire q.sage.u.in))
      ==
    [~ q.state %done ~]
  =/  c-res=output:mr  (computation +<)
  ?:  ?=(%cont -.next.c-res)
    [darts.c-res state.c-res %cont ..$(computation self.next.c-res)]
  ?:  ?=(%done -.next.c-res)
    =/  fin=form:m
      ;<  ~  bind:m  (cancel-timer:io wire)
      (pure:m `value.next.c-res)
    [darts.c-res state.c-res %cont fin]
  ?:  ?=(%fail -.next.c-res)
    =/  err=tang  err.next.c-res
    =/  fin=form:m
      ;<  ~  bind:m  (cancel-timer:io wire)
      |=  input:fiber:nexus
      [~ q.state %fail err]
    [darts.c-res state.c-res %cont fin]
  :+  darts.c-res  state.c-res
  ?-  -.next.c-res
    %wait  [%wait ~]
    %skip  [%skip ~]
  ==
++  keen-page-raw
  |=  [shp=@p rel=path rev=@ud]
  =/  m  (fiber:fiber:nexus ,(unit [p=@tas q=@t]))
  ^-  form:m
  =/  pax=path  (keen-path rel rev)
  ;<  res=(unit (unit page))  bind:m
    ::  +deadline, not +with-timeout:io, so this file builds on every
    ::  grubbery generation the fleet runs. See the arm above.
    ((deadline ,(unit page)) mesa-timeout (keen:io shp pax))
  ::  outer ~: our own deadline fired, so cancel the parked request.
  ::  inner ~: the publisher bound nothing at that spur (never grown, or
  ::  culled). keen:io hands back the page the kernel's verified %sage
  ::  carried, valed through the %keen-response mark (see +keen:io /
  ::  +take-keen-sage in grubbery), so pag is a well-formed page: an atom
  ::  mark and any noun body.
  ?~  res
    ;<  ~  bind:m  (yawn:io shp pax)
    (pure:m ~)
  ?~  u.res  (pure:m ~)
  =/  pag  u.u.res
  ::  narrow the body to @t. The mirror grows [%gmi @t] bodies and the [%del '']
  ::  tombstone, both @t bodies; a non-@t body is a publisher we do not
  ::  understand, so the mule reads it as ~ rather than crashing.
  =/  got=(each [p=@tas q=@t] tang)  (mule |.(;;([p=@tas q=@t] [p q]:pag)))
  ?:(?=(%| -.got) (pure:m ~) (pure:m `p.got))
::  +keen-page: the body-only read, a [%gmi body] binding's body, ~ for a
::  miss, a tombstone, or a mark we do not understand.
::
++  keen-page
  |=  [shp=@p rel=path rev=@ud]
  =/  m  (fiber:fiber:nexus ,(unit @t))
  ^-  form:m
  ;<  pg=(unit [p=@tas q=@t])  bind:m  (keen-page-raw shp rel rev)
  ?~  pg  (pure:m ~)
  ?.  =(%gmi p.u.pg)  (pure:m ~)
  (pure:m `q.u.pg)
::  +read-pub-index-remote: a peer's /pub/index via peek-remote (clean break:
::  the peer must run the grubbery-native lattice at the same app-base).
::
++  read-pub-index-remote
  |=  shp=@p
  =/  m  (fiber:fiber:nexus ,(unit pub-index:lp))
  ^-  form:m
  ;<  ms=(unit view:nexus)  bind:m
    (peek-remote-wait [%& %& (weld app-base:lu /pub) %index] shp)
  ::  ~ means the read FAILED (timeout / not-a-file / bad clam), distinct from a
  ::  reachable peer with a genuinely empty index (`~ *pub-index). Callers use the
  ::  difference: reconcile must NOT run on a failure (it would delete every row).
  ?~  ms  (pure:m ~)
  ?.  ?=([%file *] u.ms)  (pure:m ~)
  ::  CROSS-SHIP peek content is a boom (raw noun), not a vase. need-vase would
  ::  crash the reader. Extract via sang-noun and clam in a mule so a malformed
  ::  or hostile peer index yields ~ (treated as unreachable) instead of crashing.
  =/  res=(each pub-index:lp tang)
    (mule |.(;;(pub-index:lp (sang-noun:tarball sang.u.ms))))
  ?:(?=(%| -.res) (pure:m ~) (pure:m `p.res))
::  +read-pub-index-any: a ship's pub index, local peek for our own ship, the
::  bounded remote peek for a peer. ~ = unreachable/denied/absent (a reachable
::  but empty peer yields `~ *pub-index). Used by /fetch's manifest fallback.
::
++  read-pub-index-any
  |=  shp=@p
  =/  m  (fiber:fiber:nexus ,(unit pub-index:lp))
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  ;<  our=@p  bind:m  bowl-our
  ?.  =(shp our)  (read-pub-index-remote shp)
  ;<  ix=pub-index:lp  bind:m  (read-pub-index (rf up /pub %index))
  (pure:m `ix)
::  +read-follows: the ships we follow. ABSOLUTE road (app-base) so it reads the
::  same from a depth-2 request fiber and a depth-0 app-root fiber.
::
++  read-follows
  =/  m  (fiber:fiber:nexus ,follows:lp)
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  ;<  seen=view:nexus  bind:m  (peek:io (rf up /sub %follows) ~)
  ?.  ?=([%file *] seen)  (pure:m *follows:lp)
  (pure:m !<(follows:lp (need-vase:tarball sang.seen)))
::  +read-subs: every live per-file subscription. Peeks /sub/pages as a ball and
::  reads each page-sub grub out of the dir node's contents (booms skipped).
::
++  read-subs
  =/  m  (fiber:fiber:nexus ,(list page-sub:lp))
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  ;<  seen=view:nexus  bind:m  (peek:io (rv up /sub/pages) ~)
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
::  +apply-sub: mutate the follow set and the page subscriptions. Runs in the
::  writer fiber (serialised), so concurrent /follow + /sub requests don't race.
::  %unfollow read-modify-write the follow set. %sub-page / %unsub-page make/cull
::  a per-page grub under /sub/pages/ (whose on-file fiber owns the live keep).
::
++  apply-sub
  |=  [root=@ud act=sub-action:lp]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ?:  ?=(?(%follow %unfollow) -.act)
    ;<  fs=follows:lp  bind:m  read-follows
    =/  fs2=follows:lp
      ?-  -.act
        %follow    (~(put in fs) ship.act)
        %unfollow  (~(del in fs) ship.act)
      ==
    (put-file (rf root /sub %follows) [/lattice %sub-follows] fs2)
  ::  a page grub's name is a deterministic hash of [ship pax], so /unsub culls the
  ::  exact grub /sub created (and re-subscribing is an idempotent over).
  =/  nom=@ta  (scot %uv (sham page-sub.act))
  =/  road=road:tarball  (rf root /sub/pages nom)
  ?:  ?=(%sub-page -.act)
    (put-file road [/lattice %sub-page] page-sub.act)
  ::  %unsub-page: cull only if present, so a stray /unsub can't veto-crash the writer.
  ;<  exists=?  bind:m  (peek-exists:io road)
  ?.  exists  (pure:m ~)
  (cull:io road)
::  +retag: %tag / %untag, touch the entry's tag set + refresh its index row.
::
++  retag
  |=  [root=@ud key-t=@t tag=@t add=?]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  =/  vbase=path  /know/vault
  ::  guard the key: %tag/%untag are reachable un-normalized via the direct
  ::  grubbery poke API (mar know-action). A bad key crashes+parks the writer.
  =/  ko=(unit path)  (know-key key-t)
  ?~  ko  ~&([%lattice-tag-bad-key key-t] (pure:m ~))
  =/  key=path  u.ko
  =/  road=road:tarball  (entry-road up vbase key)
  ;<  old=(unit know-entry:lk)  bind:m  (read-entry road)
  ?~  old  ~&([%lattice-tag-missing key] (pure:m ~))
  ::  case-fold the tag at the write boundary so explore (which normalizes the
  ::  query tag, +norm-tag) and the tag cloud agree. A stored 'Rust' would be
  ::  unreachable by an explore for 'rust'/'Rust' otherwise.
  =/  ftag=@t  (norm-tag tag)
  =/  e=know-entry:lk
    ?:  add  (add-tag:lk u.old ftag)
    ::  untag: drop BOTH the folded tag and the raw one. An entry tagged before
    ::  the case-fold landed stored it un-folded (e.g. 'Rust'), so a folded-only
    ::  del would leave it permanently unremovable.
    (del-tag:lk (del-tag:lk u.old ftag) tag)
  (put-file road [/lattice %know-entry] e)
::  +entry-road: absolute road to a key's entry grub.
::
++  entry-road
  |=  [up=@ud vbase=path key=path]
  ^-  road:tarball
  =/  vr=vrail:lk  (key-to-rail:lk vbase key)
  (rf up pax.vr nom.vr)
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
::  +put-file: one dart, no probe. %over's %make-with-force creates when the
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
::  delete. Add pruning if the tree clutters.
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
::
::  ── the obelisk commons mirror (docs/obelisk-mirror.md) ─────────────
::  Everything below talks to %obelisk the DESK, never grubbery's
::  vendored copy of the engine. The bridge arms are salvaged from the
::  pre-embedded era of this nexus, where they ran against the desk in
::  production; the peek idiom is updated to view:nexus.
::
::  +gall-poke-fire: emit a gall poke through the /sys/gall service
::  WITHOUT waiting for the poke-ack. The core's ack routing back into
::  nexus fibers never arrives on this build, so every ack-waiting
::  primitive (gall-poke, gall-poke-or-nack) wedges its fiber forever.
::  The emit side is proven (the watch poke materializes the sub), and
::  obelisk positive-acks everything, so the ack carries nothing we
::  need. The stray ack later arrives as a [/ %poke-ack] poke; loops
::  that take pokes skip it.
::
++  gall-poke-fire
  |=  [=dude:gall =page]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ;<  our=@p  bind:m  get-our:io
  (poke:io &+&+[/sys/gall %'main.sig'] [[/ %gall-poke] [[our dude] page]])
::  +obelisk-sub-base: the grubbery tree dir where obelisk's /server
::  fact is materialized by a %gall-watch subscription. The result
::  lands at .../data, the live flag at .../live.
::
++  obelisk-sub-base
  |=  our=@p
  ^-  path
  /sys/gall/subs/(scot %p our)/obelisk/server
::  +obelisk-sub-state: what the materialized /server subscription says
::  about itself. %none = grubbery never laid the dir, so no watch has
::  ever been sent. %dead = the grub exists and reads no, which means
::  the watch-ack came back an ERROR and grubbery recorded it without
::  retrying. %live = watch-acked (or a watch is in flight, since
::  grubbery lays yes before it sends the card).
::
++  obelisk-sub-state
  |=  our=@p
  =/  m  (fiber:fiber:nexus ,?(%none %dead %live))
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  =/  road=road:tarball  (rf up (obelisk-sub-base our) %live)
  ;<  ex=?  bind:m  (peek-exists:io road)
  ?.  ex  (pure:m %none)
  ;<  vw=view:nexus  bind:m  (peek:io road ~)
  ?.  ?=([%file *] vw)  (pure:m %dead)
  =/  yes=?  (fall (mole |.(!<(? (need-vase:tarball sang.vw)))) %.n)
  (pure:m ?:(yes %live %dead))
::  +obelisk-live: is the /server subscription established (watch-acked)?
::
++  obelisk-live
  |=  our=@p
  =/  m  (fiber:fiber:nexus ,?)
  ^-  form:m
  ;<  st=?(%none %dead %live)  bind:m  (obelisk-sub-state our)
  (pure:m =(%live st))
::  +obelisk-ensure-sub: make sure the /server sub is live before a
::  query. obelisk kicks all /server subscribers after each result, so
::  grubbery auto-resubscribes. This waits for the (re)subscription,
::  poking a fresh %gall-watch only when gall is holding nothing.
::
++  obelisk-ensure-sub
  |=  our=@p
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ;<  st=?(%none %dead %live)  bind:m  (obelisk-sub-state our)
  ?:  ?=(%live st)  (pure:m ~)
  ::  %dead re-watches, and that is NOT the forbidden cure poke. A
  ::  dead grub means the watch-ack was an error, so gall dropped the
  ::  request and holds no subscription: a fresh watch has nothing to
  ::  collide with. Gating this on mere grub EXISTENCE latched the
  ::  bridge shut forever, because grubbery lays the grub before it
  ::  sends the card, so one nacked watch (opening the settings page
  ::  on a ship that has not installed %obelisk yet) made every later
  ::  query time out for the life of the ship, install included.
  ;<  ~  bind:m
    (gall-poke-fire %grubbery [%gall-watch [our %obelisk /server]])
  ::  on exhaustion just return: the caller's poll deadline turns a
  ::  still-dead sub into a query error and the retry flag re-runs the
  ::  write. NEVER poke a cure here. Once the sub exists grubbery's
  ::  auto-resubscribe owns it, obelisk kicks after every result by
  ::  design, and any watch or leave poked into that cycle collides
  ::  with the auto-resub (%watch-not-unique), whose crash produces
  ::  another kick and another collision: a self-sustaining event
  ::  tornado that pinned this ship four times before the mechanism
  ::  was understood. A truly stuck sub (the zombie in
  ::  mar-core/README.md) is cured by hand from the dojo, leave then
  ::  watch, as that README documents.
  ;<  *  bind:m  (obelisk-wait-live our 40)
  (pure:m ~)
++  obelisk-wait-live
  |=  [our=@p n=@ud]
  =/  m  (fiber:fiber:nexus ,?)
  ^-  form:m
  ?:  =(0 n)  (pure:m %.n)
  ;<  live=?  bind:m  (obelisk-live our)
  ?:  live  (pure:m %.y)
  ;<  ~  bind:m  (sleep-draining (div ~s1 10))
  (obelisk-wait-live our (dec n))
::  +obelisk-run-one: run one urQL script against %obelisk and return
::  its result. obelisk answers on its /server subscription (no
::  scries), which grubbery materializes at .../data. Poke, then poll
::  that materialization until a result carrying this call's nonce
::  lands. Every caller runs the round-trip in its own fiber. No owner
::  fiber and no writer coupling: both designs wedged their shared
::  consumer on this core, taking saves down with them. The nonce is
::  what keeps concurrent callers off each other's results.
::
::  waiting is POLLING here, never a keep. A keep on a road whose grub
::  does not exist yet blocks until the grub is born on this core, so
::  the salvage era's keep-before-create idiom deadlocks every caller.
::  A bounded peek loop is dumb, core-proof, and cheap (local peeks).
::
++  read-road-noun
  |=  road=road:tarball
  =/  m  (fiber:fiber:nexus ,(unit *))
  ^-  form:m
  ;<  ex=?  bind:m  (peek-exists:io road)
  ?.  ex  (pure:m ~)
  ;<  vw=view:nexus  bind:m  (peek:io road ~)
  ?.  ?=([%file *] vw)  (pure:m ~)
  ::  a BOOM sang (grub laid without a live marc) has no vase, and a
  ::  bare need-vase on it kills the whole fiber (the pub-meta lesson).
  (pure:m (mole |.(q:(need-vase:tarball sang.vw))))
::  +poll-nonce: peek until the road's noun differs from the baseline
::  AND carries our nonce, then return it parsed. Change-only polling
::  could accept a concurrent caller's result; the nonce check cannot.
::  Peeks only: a cull is a DART into the core-owned /sys tree that
::  nothing consumes, and it parked its fiber forever.
::
++  poll-nonce
  |=  [road=road:tarball base=(unit *) nonce=@ud tries=@ud]
  =/  m  (fiber:fiber:nexus ,(unit obk-out:lm))
  ^-  form:m
  ?:  =(0 tries)  (pure:m ~)
  ;<  cur=(unit *)  bind:m  (read-road-noun road)
  ?:  &(?=(^ cur) !=(cur base))
    ;<  res=obk-out:lm  bind:m  (obelisk-read-data road)
    ?:  (result-has-nonce res nonce)  (pure:m (some res))
    ;<  ~  bind:m  (sleep-draining (div ~s1 4))
    ::  RE-BASELINE on a foreign result. Recursing with the original
    ::  base would leave the changed test true for the whole remaining
    ::  deadline, so every later try re-peeks and re-molds a noun that
    ::  has not moved, hundreds of times, inside one fiber. One
    ::  unbounded SELECT left in the shared slot by another caller was
    ::  enough to make that the dominant cost of every poll.
    (poll-nonce road cur nonce (dec tries))
  ;<  ~  bind:m  (sleep-draining (div ~s1 4))
  (poll-nonce road base nonce (dec tries))
::  +result-has-nonce: does any result-set cell carry the nonce value?
::  Error results pass unconditionally: the engine aborts the whole
::  script on error, so the trailing SELECT never ran and the tang IS
::  the answer to OUR script only if it names our statements, which
::  cannot be checked cheaply. Accepting errors keeps the caller's
::  worst case at one misattributed failure followed by a retry,
::  against certain misattribution without the nonce.
::
++  result-has-nonce
  |=  [res=obk-out:lm nonce=@ud]
  ^-  ?
  ?:  ?=(%| -.res)  %.y
  %+  lien  p.res
  |=  cr=obk-cmd-result:lm
  %+  lien  p.cr
  |=  r=obk-result:lm
  ?.  ?=(%result-set -.r)  %.n
  %+  lien  p.r
  |=  v=obk-vector:lm
  %+  lien  `(list obk-cell:lm)`p.v
  |=  c=obk-cell:lm
  =(nonce q.q.c)
::  +timeout-leaf: the tang a poll deadline miss carries. Callers tell
::  "we stopped waiting" from "the engine rejected this" by testing it
::  (+is-timeout), and the difference matters: an engine error names a
::  poisoned row or a missing table and deserves a per-row replay or a
::  cursor zeroing, while a timeout means nothing at all was learned.
::  Treating the two alike replayed 32 statements at a minute each
::  against an unresponsive desk, and zeroed cursors (destroying the
::  tombstone basis) whenever one probe ran cold.
::
++  timeout-leaf  ^-  @t  'obelisk: query timed out (desk down?)'
++  is-timeout
  |=  res=obk-out:lm
  ^-  ?
  ?.  ?=(%| -.res)  %.n
  ?~  p.res  %.n
  =([%leaf (trip timeout-leaf)] i.p.res)
::  +nosub-leaf: the refusal to poke without a live subscription. It is
::  a DIFFERENT verdict from a timeout on purpose. A timeout means the
::  desk was asked and stayed silent, which says nothing about whether
::  it exists. No subscription means the desk cannot be asked at all,
::  which on a ship that never installed %obelisk is the permanent
::  truth. Folding this into the timeout made every probe on such a
::  ship read unknown forever, so the bootstrap could never conclude
::  absence and the loop retried every five minutes for the life of
::  the ship instead of settling into its half-hourly quiet.
::
++  nosub-leaf  ^-  @t  'obelisk: no /server subscription (desk absent?)'
++  is-nosub
  |=  res=obk-out:lm
  ^-  ?
  ?.  ?=(%| -.res)  %.n
  ?~  p.res  %.n
  =([%leaf (trip nosub-leaf)] i.p.res)
::  +is-silent: the desk told us NOTHING, whether because it stayed
::  quiet past the deadline or because there was no subscription to ask
::  over. Every decision point uses this one predicate, never the two
::  sentinels separately. Wiring them separately is what produced the
::  last round of defects: the probe path learned about nosub and the
::  write path did not, so a subscription gap read as a poisoned row,
::  replayed thirty-two times, and let a cursor advance over rows that
::  were never written. The two tangs stay distinct only so the
::  message a human reads names the real condition.
::
++  is-silent
  |=  res=obk-out:lm
  ^-  ?
  |((is-timeout res) (is-nosub res))
++  obelisk-run-one
  |=  [db=@tas urql=tape]
  =/  m  (fiber:fiber:nexus ,obk-out:lm)
  ^-  form:m
  (obelisk-run-tries db urql 240)
::  +obelisk-run-tries: the round trip with an explicit poll budget in
::  quarter seconds. The write path wants patience (a minute, above
::  real statement latency). A presence check wants an answer.
::
++  obelisk-run-tries
  |=  [db=@tas urql=tape tries=@ud]
  =/  m  (fiber:fiber:nexus ,obk-out:lm)
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  ;<  our=@p  bind:m  get-our:io
  =/  data-road=road:tarball  (rf up (obelisk-sub-base our) %data)
  ;<  ~  bind:m  (obelisk-ensure-sub our)
  ::  no live subscription means no poke, for two reasons. The mild
  ::  one: obelisk answers ONLY on /server, so a poke sent with no
  ::  subscription can never produce a result and the poll below would
  ::  burn its whole deadline learning that. The severe one: grubbery
  ::  resolves the target's marc through a scry that CRASHES when the
  ::  agent is not running, and the crash rolls back the event and
  ::  parks the emitting fiber, so a poke at an absent %obelisk can
  ::  take the reconciler down until the next nexus reload. Ships
  ::  without the desk are the normal case (rule 3, optional
  ::  presence), so this path must never poke blind.
  ;<  st=?(%none %dead %live)  bind:m  (obelisk-sub-state our)
  ?.  ?=(%live st)
    (pure:m [%| ~[leaf+(trip nosub-leaf)]])
  ::  the NONCE closes the shared-sub race: a trailing SELECT of a
  ::  fresh number rides every script, and only a result carrying that
  ::  number is accepted as ours. A concurrent caller's result fails
  ::  the check and reads as not-yet, never as a false verdict.
  ;<  eny=@uvJ  bind:m  get-entropy:io
  =/  nonce=@ud  (mod `@ud`eny 1.000.000.000)
  =/  script=tape  :(weld urql " SELECT " (trip (scot %ud nonce)) ";")
  ;<  base=(unit *)  bind:m  (read-road-noun data-road)
  ::  fire-and-forget at the gall layer: obelisk wraps queries in a
  ::  mule and always positive-acks; the result comes on /server.
  ;<  ~  bind:m  (gall-poke-fire %obelisk [%obelisk-action [%tape db script]])
  ::  a down/unresponsive desk returns an error rather than hanging:
  ::  240 tries at a quarter second is the poll deadline. A minute,
  ::  because obelisk statements really cost seconds to tens of
  ::  seconds on modest hardware, and a deadline under the real
  ::  latency reads a slow desk as dead, fails every verdict, and
  ::  turns the retry into a permanent loop that never lands anything.
  ;<  res=(unit obk-out:lm)  bind:m  (poll-nonce data-road base nonce tries)
  ?~  res
    ::  no self-healing here: a leave or watch poked at a slow-or-dead
    ::  sub collides with grubbery's kick-driven auto-resubscribe and
    ::  tornadoes (see +obelisk-ensure-sub). The timeout is the whole
    ::  verdict, the retry flag re-runs the write, and the zombie sub
    ::  is a documented dojo cure.
    (pure:m [%| ~[leaf+(trip timeout-leaf)]])
  ::  settle: obelisk kicks /server right after the fact; let grubbery
  ::  process the kick + auto-resub so a back-to-back query's ensure-sub
  ::  sees a stable sub rather than a live=y about to be torn down.
  ;<  ~  bind:m  (sleep-draining (div ~s1 2))
  (pure:m u.res)
::  +obelisk-read-data: read the materialized /server fact grub. The
::  fact may arrive page-wrapped as [%noun <each>]; unwrap and clam.
::
++  obelisk-read-data
  |=  data-road=road:tarball
  =/  m  (fiber:fiber:nexus ,obk-out:lm)
  ^-  form:m
  ;<  vw=view:nexus  bind:m  (peek:io data-road ~)
  ?.  ?=([%file *] vw)
    (pure:m [%| ~[leaf+"obelisk: no result grub"]])
  ::  mole the extraction: a BOOM sang has no vase and a bare need-vase
  ::  kills the fiber (the pub-meta lesson).
  =/  mraw=(unit *)  (mole |.(q:(need-vase:tarball sang.vw)))
  ?~  mraw  (pure:m [%| ~[leaf+"obelisk: unreadable result grub"]])
  =/  raw=*  u.mraw
  =/  en=*  ?:(&(?=(^ raw) =(%noun -.raw)) +.raw raw)
  =/  parsed  (mule |.(;;(obk-out:lm en)))
  ?:  ?=(%| -.parsed)  (pure:m [%| p.parsed])
  (pure:m p.parsed)
::  +obelisk-json: render a result (or error) as JSON. Rows become
::  objects keyed by column name; dime values scot'd by aura, text
::  auras passed through verbatim (scot would re-escape them).
::
++  obelisk-json
  |=  res=obk-out:lm
  ^-  json
  ?:  ?=(%| -.res)
    (frond:enjs:format 'error' s+(crip (zing (turn p.res |=(=tank ~(ram re tank))))))
  =/  results=(list obk-result:lm)
    (zing (turn p.res |=(cr=obk-cmd-result:lm p.cr)))
  :-  %a
  %+  turn  results
  |=  r=obk-result:lm
  ^-  json
  ?-  -.r
    %action           (frond:enjs:format 'action' s+action.r)
    %relation-name    (frond:enjs:format 'relation' s+name.r)
    %message          (frond:enjs:format 'message' s+msg.r)
    %vector-count     (frond:enjs:format 'count' (numb:enjs:format count.r))
    %server-time      (frond:enjs:format 'server-time' s+(scot %da date.r))
    %security-time    (frond:enjs:format 'security-time' s+(scot %da date.r))
    %schema-time      (frond:enjs:format 'schema-time' s+(scot %da date.r))
    %data-time        (frond:enjs:format 'data-time' s+(scot %da date.r))
    %result-set       (frond:enjs:format 'rows' a+(turn p.r obelisk-row-json))
    %relations        (frond:enjs:format 'relations' s+'(opaque)')
    %select-relation  (frond:enjs:format 'select-relation' s+'(opaque)')
  ==
++  obelisk-row-json
  |=  v=obk-vector:lm
  ^-  json
  %-  pairs:enjs:format
  %+  turn  `(list obk-cell:lm)`p.v
  |=  c=obk-cell:lm
  ^-  [@t json]
  =/  aura=@ta  p.q.c
  :-  p.c
  ?:  |(=('t' aura) =('ta' aura) =('tas' aura))
    s+q.q.c
  s+(scot aura q.q.c)
::
::  ── the reconciler (docs/obelisk-mirror.md section 5) ───────────────
::  Content-stamp reconciliation: each pass reads the live sources with
::  the same peeks their list routes already use, diffs against the
::  cursor's stamps, and writes only the difference. Storage revisions
::  are never consulted, so a rerun after any crash re-derives the same
::  difference and the upsert is idempotent. Pacing needs no extra
::  timers: every obelisk round-trip crosses its own waits, so each
::  chunk is naturally its own event.
::
::  +mirror-trace: file-based tracing for the mirror fibers. Console
::  prints from nexus fibers are not reliably visible on this harness,
::  so debugging writes a grub the http api can read.
++  mirror-trace
  |=  msg=@ta
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  ;<  now=@da  bind:m  get-time:io
  ;<  ~  bind:m  (ensure-dirs /mirror /tr)
  (put-file (rf up /mirror/tr msg) [/ %json] s+(scot %da now))
::  +mirror-tracev: a trace carrying a value instead of a timestamp.
++  mirror-tracev
  |=  [msg=@ta val=@t]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  ;<  ~  bind:m  (ensure-dirs /mirror /tr)
  (put-file (rf up /mirror/tr msg) [/ %json] s+val)
++  mirror-run
  |=  urql=tape
  =/  m  (fiber:fiber:nexus ,obk-out:lm)
  ^-  form:m
  (obelisk-run-one mirror-db:lm urql)
::  +mirror-rows-one-by-one: the per-item fallback. A batch that
::  aborted replays one statement per poke, so one poisoned row costs
::  one row. Results are discarded: the next pass re-converges anything
::  a replay missed.
::
::  the write arms return [ok to]: whether the values LANDED, and
::  whether a poll deadline was missed. The caller needs both, because
::  an engine error and a timeout mean opposite things. An engine error
::  is information (a duplicate key, a poisoned row) and the run
::  continues. A timeout is the absence of information, the remaining
::  work is abandoned, and anything not yet written must not be
::  recorded as mirrored.
::
++  mirror-rows-one-by-one
  |=  [stmts=(list tape) ok=?]
  =/  m  (fiber:fiber:nexus ,[ok=? to=?])
  ^-  form:m
  ?~  stmts  (pure:m [ok %.n])
  ;<  r=obk-out:lm  bind:m  (mirror-run i.stmts)
  ::  a TIMEOUT ends the replay immediately. The desk is unresponsive,
  ::  so the remaining rows would each pay the full deadline to learn
  ::  the same thing, and the domain's verdict is already false. Only
  ::  an engine error is worth walking past, since that isolates one
  ::  poisoned row.
  ?:  (is-silent r)  (pure:m [%.n %.y])
  ::  name-recursion, never $: a $ with args inside a ;< continuation
  ::  cannot find the trap through the bind gates (-find.$).
  (mirror-rows-one-by-one t.stmts &(ok ?=(%& -.r)))
::  +mirror-write: one domain's difference. ups = UPDATE statements
::  (changed rows, new rows, tombstones). ins = INSERT statements for
::  brand new rows, their expected duplicate-key errors swallowed.
::  Both ride 32-statement chunks with the per-item fallback beneath
::  (see the batching note below).
::
::  +mirror-write returns whether the domain's values LANDED: the
::  verdict of every UPDATE batch (or its per-row replay). INSERT
::  verdicts stay ignored by design, their duplicate-key errors are
::  expected and every new row's values are covered by its paired
::  UPDATE anyway. A %.n verdict keeps the domain's old cursor, so a
::  failed write is retried next pass instead of silently skipped.
::
::  inserts ride the same 32-statement chunks as updates. A chunk
::  holding any duplicate aborts whole and replays row by row through
::  the shared fallback, so steady state pays one aborted poke per
::  chunk of re-inserts, and a fresh table's backfill, where no
::  duplicate is possible, lands 32 rows per poke instead of one. At
::  obelisk's per-statement cost that difference is what makes a
::  many-hundred-row backfill minutes instead of hours.
::
++  mirror-write
  |=  [ups=(list tape) ins=(list tape)]
  =/  m  (fiber:fiber:nexus ,?)
  ^-  form:m
  ::  the INSERT verdict is no longer discarded. Ignoring it was safe
  ::  only while every insert chunk was attempted, because a chunk
  ::  that aborted still fell through to the per-row replay and the
  ::  loop carried on. Now that a timeout ABANDONS the remaining
  ::  chunks, throwing the verdict away would let the domain's cursor
  ::  advance over rows that were never inserted, and their paired
  ::  UPDATE no-ops on an absent row, so those rows would be missing
  ::  from the mirror permanently with the pass reporting success.
  ::  Duplicate-key errors still do not fail a domain: those come back
  ::  as engine errors, which the chunk loop swallows through the
  ::  replay, and only a timeout can turn this verdict false.
  ;<  ir=[ok=? to=?]  bind:m  (mirror-write-chunks ins &)
  ;<  ur=[ok=? to=?]  bind:m  (mirror-write-chunks ups &)
  ::  an insert fails the domain ONLY when it timed out. A duplicate
  ::  key comes back as an engine error and is expected, so it must
  ::  never freeze the cursor, but a timeout abandoned the remaining
  ::  insert chunks and those rows really are missing.
  (pure:m &(ok.ur !to.ir))
++  mirror-write-chunks
  |=  [ups=(list tape) ok=?]
  =/  m  (fiber:fiber:nexus ,[ok=? to=?])
  ^-  form:m
  ?~  ups  (pure:m [ok %.n])
  =/  all=(list tape)  ups
  =/  chunk=(list tape)  (scag 32 all)
  ;<  r=obk-out:lm  bind:m  (mirror-run (batch:lm chunk))
  ::  a timed-out batch is NOT replayed row by row. Replaying taught
  ::  nothing and cost the deadline once per row (a 32-row chunk
  ::  became half an hour against an unresponsive desk, a whole domain
  ::  became hours, every pass). Give up on the domain, let the
  ::  verdict hold its cursor, and let the retry flag bring the next
  ::  tick back. Only an engine error earns the per-row isolation.
  ?:  (is-silent r)  (pure:m [%.n %.y])
  ;<  cr=[ok=? to=?]  bind:m
    ?:  ?=(%& -.r)  (pure:m [%.y %.n])
    (mirror-rows-one-by-one chunk &)
  ::  a replay that timed out mid-chunk abandons the rest too.
  ?:  to.cr  (pure:m [%.n %.y])
  ::  an engine error does NOT abort the domain: the replay already
  ::  isolated the poisoned row, and the later chunks are independent
  ::  and idempotent. Aborting would let one permanently bad row block
  ::  every row behind it forever, since the retry flag brings the
  ::  same pass back to the same chunk.
  (mirror-write-chunks (slag 32 all) &(ok ok.cr))
::  grub readers for the loop's own state.
::
++  mirror-enabled
  =/  m  (fiber:fiber:nexus ,?)
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  ;<  vw=view:nexus  bind:m  (peek:io (rf up /mirror %'config.json') ~)
  ?.  ?=([%file *] vw)  (pure:m %.n)
  =/  jon=json  (fall (mole |.(!<(json (need-vase:tarball sang.vw)))) ~)
  ?.  ?=([%o *] jon)  (pure:m %.n)
  =/  v=(unit json)  (~(get by p.jon) 'enabled')
  ?~  v  (pure:m %.n)
  ?.  ?=([%b *] u.v)  (pure:m %.n)
  (pure:m p.u.v)
++  read-beacon-val
  =/  m  (fiber:fiber:nexus ,@ud)
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  ;<  vw=view:nexus  bind:m  (peek:io (rf up /beacon %rev) ~)
  ?.  ?=([%file *] vw)  (pure:m 0)
  =/  jon=json  (fall (mole |.(!<(json (need-vase:tarball sang.vw)))) ~)
  ?.  ?=([%n *] jon)  (pure:m 0)
  (pure:m (fall (rush p.jon dem) 0))
++  read-mirror-cursor
  =/  m  (fiber:fiber:nexus ,mirror-cursor:lm)
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  ;<  vw=view:nexus  bind:m  (peek:io (rf up /mirror %cursor) ~)
  ?.  ?=([%file *] vw)  (pure:m *mirror-cursor:lm)
  ::  the marc is a noun passthrough (see mar/lattice/mirror-cursor),
  ::  so the vase is untyped and molding (;;) is the only clam that
  ::  works, the obk-res lesson. Try the live shape, then v1 upgraded
  ::  in place with its state trusted, so a shape change costs
  ::  nothing. Only a grub that is neither shape falls to the fresh
  ::  default and pays a full backfill.
  =/  raw=(unit *)  (mole |.((sang-noun:tarball sang.vw)))
  ?~  raw  (pure:m *mirror-cursor:lm)
  =/  new=(unit mirror-cursor:lm)
    (mole |.(;;(mirror-cursor:lm u.raw)))
  ?^  new  (pure:m u.new)
  =/  old=(unit mirror-cursor-v1:lm)
    (mole |.(;;(mirror-cursor-v1:lm u.raw)))
  ?~  old  (pure:m *mirror-cursor:lm)
  %-  pure:m
  :*  beacon.u.old  %.n  pages.u.old  knows.u.old
      tags.u.old  follows.u.old  visits.u.old
  ==
++  write-mirror-cursor
  |=  cur=mirror-cursor:lm
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  (put-file (rf up /mirror %cursor) [/lattice %mirror-cursor] cur)
::  +mirror-bootstrap: probe, create, re-probe. `set = the schema is
::  live, carrying the indices of tables MISSING at first probe (their
::  cursor state must zero: a missing table that now exists is a wipe
::  or a first run, and either way its rows need a backfill). ~ = the
::  desk is absent or unresponsive; the loop sleeps long. Probes run
::  BEFORE creates so a wiped store still shows its missing tables.
::  Creates ride ONE POKE EACH, expected already-exists errors
::  swallowed (a joined script would abort at the first live table).
::
::  +probe-verdict: what one probe learned. %yes = the table answered.
::  %no = the engine rejected the statement, which for a bare SELECT
::  of a primary key means the table is not there. %dunno = the poll
::  deadline passed, which means NOTHING was learned. The third case
::  must never be folded into %no: a probe read as "missing" zeroes
::  that domain's cursor, and the cursor is also the tombstone basis,
::  so one cold statement would silently rewrite the whole store AND
::  permanently strand every already-deleted row as live.
::
+$  probe-verdict  ?(%yes %no %dunno)
++  probe-tables
  =/  m  (fiber:fiber:nexus ,(list probe-verdict))
  ^-  form:m
  (probe-tables-loop probe-urqls:lm ~)
++  probe-tables-loop
  |=  [probes=(list tape) acc=(list probe-verdict)]
  =/  m  (fiber:fiber:nexus ,(list probe-verdict))
  ^-  form:m
  ?~  probes  (pure:m (flop acc))
  ;<  r=obk-out:lm  bind:m  (mirror-run i.probes)
  =/  v=probe-verdict
    ?:  ?=(%& -.r)  %yes
    ::  silence is UNKNOWN, never "the table is missing". Mapping a
    ::  missing subscription to %no looked like it made absence
    ::  decidable, but it cannot even fire on a desk-less ship (that
    ::  ship's live grub reads yes), and on a healthy ship every
    ::  transient subscription gap became a false wipe: the domain's
    ::  cursor zeroed, its tombstone basis destroyed, and every
    ::  already-deleted row stranded as live forever.
    ?:  (is-silent r)  %dunno
    %no
  ::  retry an unknown ONCE before recording it. The first statement
  ::  after a revive races the freshly created subscription and its
  ::  fact is lost (grubbery marks the sub live at watch creation, not
  ::  at watch-ack), so exactly one cold timeout per boot is normal
  ::  and a retry converges. Without this the bootstrap read a healthy
  ::  desk as unreachable on its very first pass.
  ;<  v2=probe-verdict  bind:m  (probe-settle i.probes v)
  (probe-tables-loop t.probes [v2 acc])
::  +probe-settle: pass a decided verdict through, retry an unknown
::  once. Lives in its own arm because pure:m inside +probe-tables-loop
::  builds the LIST fiber, not a single verdict.
::
++  probe-settle
  |=  [probe=tape v=probe-verdict]
  =/  m  (fiber:fiber:nexus ,probe-verdict)
  ^-  form:m
  ?.  ?=(%dunno v)  (pure:m v)
  ;<  r=obk-out:lm  bind:m  (mirror-run probe)
  ?:  ?=(%& -.r)  (pure:m %yes)
  (pure:m ?:((is-silent r) %dunno %no))
::  +boot-verdict: what the bootstrap concluded. %absent = every probe
::  says no table, so the desk is gone and the loop sleeps long.
::  %unclear = at least one probe timed out even after its retry, so
::  NOTHING is known: never zero a cursor on this, and come back on
::  the short tick rather than the long one, because the cause is
::  transient by nature. %ok carries the tables that were positively
::  missing and therefore need their cursor state zeroed.
::
+$  boot-verdict
  $%  [%absent ~]
      [%unclear ~]
      [%ok fresh=(set @ud)]
  ==
++  mirror-bootstrap
  =/  m  (fiber:fiber:nexus ,boot-verdict)
  ^-  form:m
  ;<  first=(list probe-verdict)  bind:m  probe-tables
  ?:  (levy first |=(f=probe-verdict =(%yes f)))  (pure:m [%ok *(set @ud)])
  ?:  (lien first |=(f=probe-verdict =(%dunno f)))  (pure:m [%unclear ~])
  ;<  *  bind:m  (mirror-run create-db-urql:lm)
  ;<  ~  bind:m  (run-creates create-list:lm)
  ;<  again=(list probe-verdict)  bind:m  probe-tables
  ::  every table still missing after the creates reads as an absent
  ::  or unresponsive desk. A MIXED re-probe is a partial recovery:
  ::  return the fresh set anyway so the zeroing lands and the pass
  ::  writes what it can. The failed writes set the retry flag and the
  ::  next tick finishes the job, and the zeroing persists through the
  ::  pass's own cursor writes, so an interrupted recovery never
  ::  strands a table with pre-wipe stamps.
  ?:  (levy again |=(f=probe-verdict =(%no f)))  (pure:m [%absent ~])
  ::  an unknown on the SECOND probe does NOT abort. The fresh set is
  ::  folded from the FIRST probe, which is already decided and
  ::  dunno-free by the guard above, and the creates have ALREADY run
  ::  by this point. Returning unclear here threw that decision away
  ::  after changing the store, so the next tick saw every table
  ::  present, zeroed nothing, and left the freshly created tables
  ::  permanently empty with no tick able to notice. Carry the set
  ::  through and let a failed write set the retry flag instead.
  ::  zero only what the FIRST probe positively found missing. %dunno
  ::  cannot reach here (the guard above returned), so this is a real
  ::  engine "no such table".
  =/  fresh=(set @ud)
    =|  s=(set @ud)
    =/  fl=(list probe-verdict)  first
    =/  i=@ud  0
    |-  ^-  (set @ud)
    ?~  fl  s
    $(fl t.fl, i +(i), s ?:(=(%no i.fl) (~(put in s) i) s))
  (pure:m [%ok fresh])
::  v1 cleanup is a RUNBOOK STEP, not resident code: the automated
::  version crashed the reconciler into a respawn storm and a
::  once-per-ship cleanup never earned that risk. The statements live
::  in v1-drop-list:lm; run them through POST /obelisk-query on any
::  ship that ran the first catalog.
::  +obelisk-installed: presence, answered fast. A live subscription is
::  proof on its own. Otherwise ensure-sub inside the round trip pokes
::  a fresh watch (including over a dead grub, see +obelisk-ensure-sub)
::  and a SHORT poll budget decides. Presence does not need the write
::  path's patience, and this runs on every settings page load, so the
::  minute-long budget made an owner-facing GET hang for a minute on
::  exactly the ships the page exists to help.
::
++  obelisk-installed
  =/  m  (fiber:fiber:nexus ,?)
  ^-  form:m
  ;<  our=@p  bind:m  get-our:io
  ;<  live=?  bind:m  (obelisk-live our)
  ?:  live  (pure:m %.y)
  ;<  r=obk-out:lm  bind:m  (obelisk-run-tries mirror-db:lm "SELECT 1;" 40)
  (pure:m ?=(%& -.r))
++  run-creates
  |=  creates=(list tape)
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ?~  creates  (pure:m ~)
  ;<  *  bind:m  (mirror-run i.creates)
  (run-creates t.creates)
::  +zero-fresh: reset the cursor state of tables that were missing at
::  probe time, so the pass backfills them. Index order matches
::  +probe-urqls: pages knows tags follows visits docs.
::
++  zero-fresh
  |=  [cur=mirror-cursor:lm fresh=(set @ud)]
  ^-  mirror-cursor:lm
  =?  cur  (~(has in fresh) 0)  cur(pages ~)
  =?  cur  (~(has in fresh) 1)  cur(knows ~)
  =?  cur  (~(has in fresh) 2)  cur(tags ~)
  =?  cur  (~(has in fresh) 3)  cur(follows ~)
  =?  cur  (~(has in fresh) 4)  cur(visits ~)
  cur
::  kind and display name from a page's last path segment. Kinds derive
::  from the extension everywhere in lattice (the kind-parity rule);
::  extensionless names default to md.
::
++  ext-of
  |=  rel=path
  ^-  @t
  =/  nm=tape  (trip ?~(rel '' (rear rel)))
  =/  dot=(unit @ud)  (find "." (flop nm))
  ?~  dot  'md'
  (crip (flop (scag u.dot (flop nm))))
++  name-of
  |=  rel=path
  ^-  @t
  =/  nm=tape  (trip ?~(rel '' (rear rel)))
  =/  dot=(unit @ud)  (find "." (flop nm))
  ?~  dot  (crip nm)
  (crip (flop (slag +(u.dot) (flop nm))))
::  ── domain passes ───────────────────────────────────────────────────
::  Each returns [landed cursor]: the cursor with ITS map replaced by
::  the swept state when the write landed, unchanged when it did not,
::  plus the verdict itself so the loop can hold the beacon back and
::  retry a failed domain next tick. The caller persists the cursor
::  after each domain, so a crash between domains reruns only the
::  domain in flight.
::
++  mirror-pages
  |=  cur=mirror-cursor:lm
  =/  m  (fiber:fiber:nexus ,[? mirror-cursor:lm])
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  ;<  ~  bind:m  (mirror-trace %pages-start)
  ;<  our=@p  bind:m  get-our:io
  ;<  now=@da  bind:m  get-time:io
  ;<  vw=view:nexus  bind:m  (peek:io (rv up /page) ~)
  =/  pages=(list [rel=path body=@t shr=share-mode:le])
    ?.  ?=([%ball *] vw)  ~
    (index-walk ball.vw ~)
  =/  rows=(list [rel=path stamp=@ r=page-row:lm])
    %+  turn  pages
    |=  [rel=path body=@t shr=share-mode:le]
    =/  sh=@t  (scope-of shr)
    [rel (sham body sh) `page-row:lm`[rel (ext-of rel) (name-of rel) now sh]]
  =/  nxt=(map path @)  (malt (turn rows |=([rel=path stamp=@ *] [rel stamp])))
  =/  ups=(list tape)
    %-  zing
    :~  ::  changed or new rows all ride the UPDATE batch. For a new row
        ::  the update is the crash-safety net behind its insert.
        %+  turn
          (skim rows |=([rel=path stamp=@ *] !=(`(unit @)`[~ stamp] (~(get by pages.cur) rel))))
        |=([* * r=page-row:lm] (page-update:lm our r))
        ::  tombstones: mirrored before, absent from the source now.
        %+  turn
          (skip ~(tap by pages.cur) |=([rel=path *] (~(has by nxt) rel)))
        |=([rel=path *] (page-dead:lm our rel))
    ==
  =/  ins=(list tape)
    %+  turn
      (skip rows |=([rel=path *] (~(has by pages.cur) rel)))
    |=([* * r=page-row:lm] (page-insert:lm our r))
  ;<  ~  bind:m
    %+  mirror-tracev  %pages-swept
    (crip (weld (a-co:co (lent ups)) (weld "/" (a-co:co (lent ins)))))
  ;<  ok=?  bind:m  (mirror-write ups ins)
  ;<  ~  bind:m  (mirror-tracev %pages-wrote ?:(ok 'y' 'n'))
  (pure:m [ok ?:(ok cur(pages nxt) cur)])
++  mirror-knows
  |=  cur=mirror-cursor:lm
  =/  m  (fiber:fiber:nexus ,[? mirror-cursor:lm])
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  ;<  ~  bind:m  (mirror-trace %knows-start)
  ::  an ABSOLUTE sweep, never read-know-map: that arm peeks up-2
  ::  relative for request fibers, and from the reconciler's depth it
  ::  climbs past the nexus root into the void, crashing the fiber
  ::  into a respawn storm.
  ;<  seen=view:nexus  bind:m
    (peek:io (rv up /know/vault) ~)
  =/  es=(map path know-entry:lk)
    ?.  ?=([%ball *] seen)  ~
    (collect-entries ~ ball.seen)
  ;<  ~  bind:m  (mirror-trace %knows-swept)
  =/  ents=(list [key=path e=know-entry:lk])  ~(tap by es)
  =/  nxt=(map path @da)  (malt (turn ents |=([key=path e=know-entry:lk] [key updated.e])))
  =/  ups=(list tape)
    %-  zing
    :~  %+  turn
          (skim ents |=([key=path e=know-entry:lk] !=(`(unit @da)`[~ updated.e] (~(get by knows.cur) key))))
        |=([key=path e=know-entry:lk] (know-update:lm key updated.e))
        %+  turn
          (skip ~(tap by knows.cur) |=([key=path *] (~(has by nxt) key)))
        |=([key=path *] (know-dead:lm key))
    ==
  =/  ins=(list tape)
    %+  turn
      (skip ents |=([key=path *] (~(has by knows.cur) key)))
    |=([key=path e=know-entry:lk] (know-insert:lm key updated.e))
  ;<  ~  bind:m  (mirror-trace ?~(ins %knows-no-ins %knows-has-ins))
  ;<  kok=?  bind:m  (mirror-write ups ins)
  ;<  ~  bind:m  (mirror-trace %knows-wrote)
  ::  tags ride the same sweep: one row per (key, tag) application.
  =/  cur-tags=(set [path @t])
    %-  ~(gas in *(set [path @t]))
    %-  zing
    %+  turn  ents
    |=([key=path e=know-entry:lk] (turn ~(tap in tags.e) |=(t=@t [key t])))
  =/  fresh-tags=(list [path @t])
    (skip ~(tap in cur-tags) |=(p=[path @t] (~(has in tags.cur) p)))
  =/  dead-tags=(list [path @t])
    (skip ~(tap in tags.cur) |=(p=[path @t] (~(has in cur-tags) p)))
  =/  tag-ups=(list tape)
    %-  zing
    :~  (turn fresh-tags |=([key=path t=@t] (tag-update:lm key t)))
        (turn dead-tags |=([key=path t=@t] (tag-dead:lm key t)))
    ==
  =/  tag-ins=(list tape)
    (turn fresh-tags |=([key=path t=@t] (tag-insert:lm key t)))
  ;<  tok=?  bind:m  (mirror-write tag-ups tag-ins)
  ;<  ~  bind:m  (mirror-trace %tags-wrote)
  %-  pure:m
  :-  &(kok tok)
  ?.  kok  cur(tags ?:(tok cur-tags tags.cur))
  ?.  tok  cur(knows nxt)
  cur(knows nxt, tags cur-tags)
++  mirror-follows
  |=  cur=mirror-cursor:lm
  =/  m  (fiber:fiber:nexus ,[? mirror-cursor:lm])
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  ;<  ~  bind:m  (mirror-trace %follows-start)
  ;<  vw=view:nexus  bind:m  (peek:io (rf up /sub %follows) ~)
  =/  fs=(set @p)
    ?.  ?=([%file *] vw)  ~
    (fall (mole |.(!<(follows:lp (need-vase:tarball sang.vw)))) ~)
  =/  fresh=(list @p)  (skip ~(tap in fs) |=(s=@p (~(has in follows.cur) s)))
  =/  dead=(list @p)   (skip ~(tap in follows.cur) |=(s=@p (~(has in fs) s)))
  =/  ups=(list tape)
    %-  zing
    :~  (turn fresh |=(s=@p (follow-update:lm s ~)))
        (turn dead |=(s=@p (follow-dead:lm s ~)))
    ==
  =/  ins=(list tape)  (turn fresh |=(s=@p (follow-insert:lm s ~)))
  ;<  ok=?  bind:m  (mirror-write ups ins)
  (pure:m [ok ?:(ok cur(follows fs) cur)])
::  +visit-rows: the history grub as mirror rows. Entries whose url is
::  not an urb:// page have no doc identity and are skipped.
::
++  visit-rows
  =/  m  (fiber:fiber:nexus ,(list [url=@t stamp=@ r=visit-row:lm]))
  ^-  form:m
  ;<  up=@ud  bind:m  nexus-up
  ;<  vw=view:nexus  bind:m  (peek:io (rf up / %history) ~)
  =/  hist=history:lh
    ?.  ?=([%file *] vw)  ~
    (fall (mole |.(!<(history:lh (need-vase:tarball sang.vw)))) ~)
  %-  pure:m
  %-  zing
  %+  turn  hist
  |=  v=visit:lh
  ^-  (list [url=@t stamp=@ r=visit-row:lm])
  =/  pu=(unit [=ship =path])  (parse-urb-url:lu url.v)
  ?~  pu  ~
  :_  ~
  :+  url.v  (sham title.v last.v hits.v)
  `visit-row:lm`[ship.u.pu path.u.pu title.v last.v hits.v]
++  mirror-visits
  |=  cur=mirror-cursor:lm
  =/  m  (fiber:fiber:nexus ,[? mirror-cursor:lm])
  ^-  form:m
  ;<  rows=(list [url=@t stamp=@ r=visit-row:lm])  bind:m  visit-rows
  ::  the cursor keeps ONLY the current history window, so it stays
  ::  bounded by the history cap. A url that rotated out and comes back
  ::  reads as new: its INSERT fails quietly on the surviving row and
  ::  the UPDATE beside it (changed includes new) repairs the values.
  ::  Rows already mirrored for rotated-out entries persist untouched,
  ::  the best-effort stance of the seen tables.
  =/  nxt=(map @t @)
    (malt (turn rows |=([url=@t stamp=@ *] [url stamp])))
  =/  changed=(list [url=@t stamp=@ r=visit-row:lm])
    (skim rows |=([url=@t stamp=@ *] !=(`(unit @)`[~ stamp] (~(get by visits.cur) url))))
  =/  ups=(list tape)
    (turn changed |=([* * r=visit-row:lm] (visit-update:lm r)))
  =/  ins=(list tape)
    %+  turn
      (skip rows |=([url=@t *] (~(has by visits.cur) url)))
    |=([* * r=visit-row:lm] (visit-insert:lm r))
  ;<  ok=?  bind:m  (mirror-write ups ins)
  (pure:m [ok ?:(ok cur(visits nxt) cur)])
++  mirror-pass
  |=  cur=mirror-cursor:lm
  =/  m  (fiber:fiber:nexus ,[? mirror-cursor:lm])
  ^-  form:m
  ;<  pag=[ok=? cur=mirror-cursor:lm]  bind:m  (mirror-pages cur)
  ;<  ~  bind:m  (write-mirror-cursor cur.pag)
  ;<  ~  bind:m  (mirror-trace %cursor-wrote-1)
  ;<  kno=[ok=? cur=mirror-cursor:lm]  bind:m  (mirror-knows cur.pag)
  ;<  ~  bind:m  (write-mirror-cursor cur.kno)
  ;<  fol=[ok=? cur=mirror-cursor:lm]  bind:m  (mirror-follows cur.kno)
  ;<  ~  bind:m  (write-mirror-cursor cur.fol)
  ;<  vis=[ok=? cur=mirror-cursor:lm]  bind:m  (mirror-visits cur.fol)
  ;<  ~  bind:m  (write-mirror-cursor cur.vis)
  (pure:m [&(ok.pag ok.kno ok.fol ok.vis) cur.vis])
::  +obelisk-ensure: install %obelisk from its publisher when the agent
::  is not running here. Presence is a gall liveness scry, never a poke
::  at the agent: a poke at an absent agent is neither acked nor refused
::  and would wedge this fiber. The install poke is the one the settings
::  button fires; kiln makes it a no-op while a sync already exists, so
::  a slow first download and a later boot do not fight. A desk that
::  has a source from another ship is never touched (see below).
::
++  obelisk-ensure
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ;<  running=?  bind:m  (typed-scry:io ? %loob /gu/obelisk/$)
  ?:  running  (pure:m ~)
  ::  not running is not the same as absent. A desk installed from any
  ::  publisher and merely suspended has a kiln source, and a kiln
  ::  install would REPLACE that source with ours. Leave it alone.
  =/  sources-mold  (map @tas (pair @p @tas))
  ;<  srcs=(map @tas (pair @p @tas))  bind:m
    (typed-scry:io sources-mold %noun /gx/hood/kiln/sources/noun)
  ?:  (~(has by srcs) %obelisk)  (pure:m ~)
  ~&  >  %lattice-installing-obelisk
  (gall-poke-fire %hood [%kiln-install [%obelisk ~dister-nomryg-nilref %obelisk]])
::  +mirror-loop: the reconciler's life. Wake, check the enabled flag,
::  find whether anything changed (the beacon for content, a local
::  history diff for visits, which deliberately never bump the
::  beacon), and only then touch obelisk at all: probe, backfill what
::  a wipe or first run lost, mirror the difference. An idle tick
::  costs three local peeks and no obelisk traffic.
::
++  mirror-loop
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ::  once per fiber life, before anything else: make sure obelisk is
  ::  on this ship, so the mirror has a desk to talk to the moment it
  ::  is switched on. A fresh install gets its dependency unattended.
  ;<  ~  bind:m  obelisk-ensure
  |-
  ;<  on=?  bind:m  mirror-enabled
  ?.  on
    ::  a short disabled tick (one local config read) so the settings
    ::  toggle takes effect within minutes, not half an hour.
    ;<  ~  bind:m  (sleep-draining ~m5)
    $
  ;<  bv=@ud  bind:m  read-beacon-val
  ;<  cur=mirror-cursor:lm  bind:m  read-mirror-cursor
  ;<  vrows=(list [url=@t stamp=@ r=visit-row:lm])  bind:m  visit-rows
  =/  visits-idle=?
    %+  levy  vrows
    |=([url=@t stamp=@ *] =(`(unit @)`[~ stamp] (~(get by visits.cur) url)))
  ?:  &(=(bv beacon.cur) visits-idle !retry.cur)
    ;<  ~  bind:m  (sleep-draining ~m5)
    $
  ;<  ~  bind:m  (mirror-trace %boot-start)
  ;<  boot=boot-verdict  bind:m  mirror-bootstrap
  ?:  ?=(%absent -.boot)
    ::  the desk is absent or down. Say so once in a while, stay quiet
    ::  otherwise, and lose nothing: the cursor still marks everything
    ::  unmirrored, so the first healthy pass catches up whole.
    ;<  ~  bind:m  (mirror-trace %boot-absent)
    ;<  ~  bind:m  (sleep-draining ~m30)
    $
  ?:  ?=(%unclear -.boot)
    ::  a probe timed out twice, so nothing is known. Zero nothing and
    ::  come back on the SHORT tick: the causes are transient (a cold
    ::  engine, a fact lost to a just-created subscription), and the
    ::  half-hour sleep that absence earns would strand a healthy desk
    ::  for thirty minutes over one slow statement.
    ;<  ~  bind:m  (mirror-trace %boot-unclear)
    ;<  ~  bind:m  (sleep-draining ~m5)
    $
  ;<  ~  bind:m  (mirror-trace %boot-done)
  =.  cur  (zero-fresh cur fresh.boot)
  ::  a wipe found during a visits-only wake still backfills the wiped
  ::  domains: zero-fresh made their sweeps rewrite everything, so run
  ::  the full pass whenever bootstrap zeroed anything.
  ;<  res=[ok=? cur=mirror-cursor:lm]  bind:m
    ?:  &(=(bv beacon.cur) =(~ fresh.boot) !retry.cur)  (mirror-visits cur)
    (mirror-pass cur)
  ::  the retry flag is the retry gate. A pass with any failed domain
  ::  sets it, so the next tick re-enters the FULL pass even when the
  ::  beacon never moved (the wipe recovery path runs with the beacon
  ::  already equal, so the beacon alone cannot carry the signal). A
  ::  clean pass clears it and stamps the beacon.
  ;<  ~  bind:m
    %-  write-mirror-cursor
    ?:(ok.res cur.res(beacon bv, retry |) cur.res(retry &))
  ;<  ~  bind:m  (sleep-draining ~m5)
  $
--
