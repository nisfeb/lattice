::  /lib/lattice-share, cross-ship share notices.
::
::  When you share a file with a ship, they have no way to know. A weir grant
::  is invisible to the grantee. So the granting side sends a small NOTICE
::  poke, and the recipient keeps a "shared with me" list. The list is a set
::  of claims, not capabilities. The weir is the only authority. A notice can
::  be stale (revoked since) or spurious (never granted). Opening the
::  entry is what proves it either way. That is also why entries are capped
::  and removable. This is a bookmark list a stranger can append to.
::
|%
::  +$  action: what arrives at the shares inbox.
::
::  The sender's identity is NEVER in here. The inbox takes it from the poke's
::  transport (+get-poke-src), the same rule the comment design records. %del
::  is the owner's own curation and is refused from foreign ships. %put is
::  the owner's own too: a link moved back to shared with me, which names
::  the host itself, so from any other ship it is dropped.
::
::  %dir is a folder shared whole: one entry for the folder, not one per
::  page. Its pax names the folder's index grub, <base>/page/<rel>/dir-index
::  (+dir-key), which is what the receiver reads to list the pages. Its
::  %del is the plain %del with that pax. A lattice older than %dir fails
::  the soft cast and drops it, so it lists nothing for a folder until it
::  updates (a page shared on its own still reaches it as %add).
+$  action
  $%  [%add pax=path mode=@t]          ::  mode: 'read' | 'edit'
      [%dir pax=path mode=@t]          ::  a folder, by its dir-index
      [%del host=@p pax=path]
      [%put host=@p pax=path mode=@t]
  ==
+$  entry   [host=@p pax=path mode=@t when=@da]
+$  shared  (list entry)               ::  newest first
::  +cap: list bound. Anyone may poke the inbox, so without a cap a hostile
::  ship grows the grub without limit. With one they can at worst churn it.
::  A folder is one entry however many pages it holds, so the cap counts
::  shares, not pages. Over the cap the oldest entries go first (the list
::  is newest first, and +put-entry keeps its head). At the cap the list
::  is about 2000 short nouns on the ship and some 260 KB of JSON from
::  /shared-with-me.
++  cap  ^-(@ud 2.000)
::  +dir-key: is this entry path a folder's (its dir-index), not a page's
++  dir-key
  |=  p=path
  ^-  ?
  &(?=(^ p) =(%'dir-index' (rear p)))
::  +dir-cover: the folder entry from `host` that the folder notice `pax`
::  falls in: its own entry, or one for a folder above it
++  dir-cover
  |=  [cur=shared host=@p pax=path]
  ^-  (unit entry)
  =/  own=path  (snip pax)
  |-  ^-  (unit entry)
  ?~  cur  ~
  =/  d=path  (snip pax.i.cur)
  ?:  ?&  =(host host.i.cur)
          (dir-key pax.i.cur)
          =(d (scag (lent d) own))
      ==
    `i.cur
  $(cur t.cur)
::  +put-entry: dedupe on [host pax] (a re-share updates mode and timestamp,
::  it does not duplicate), prepend, cap.
++  put-entry
  |=  [cur=shared new=entry]
  ^-  shared
  ::  bind before the wet gate. scag casts through its argument's type, and the
  ::  raw [new (skip ...)] cell types as a lest, which cannot be ~, so the
  ::  cast mull-grows. The face widens it back to (list entry) first.
  =/  all=shared
    :-  new
    %+  skip  cur
    |=(e=entry &(=(host.e host.new) =(pax.e pax.new)))
  (scag cap all)
::  +host-cap: how many entries one host may hold in the list. The global
::  +cap alone let one ship evict every other host's entries by sending
::  +cap notices; with this, one host fills at most its own share.
++  host-cap  ^-(@ud 500)
::  +pax-segs, +pax-bytes: the longest notice path the inbox keeps. A page
::  path is a base, /page, the page's rel and a grub name, so these are
::  far beyond any real one, and bound what a stranger can make us store.
++  pax-segs   ^-(@ud 64)
++  pax-bytes  ^-(@ud 2.048)
::  +pax-ok: is a notice path within those bounds, every segment sane
++  pax-ok
  |=  p=path
  ^-  ?
  ?&  (lte (lent p) pax-segs)
      (lte (roll p |=([s=@ta n=@ud] :(add n 1 (met 3 s)))) pax-bytes)
      (levy p |=(s=@ta &(!=(%$ s) ((sane %ta) s))))
  ==
::  +host-full: may `host` not add the entry `pax`: it holds +host-cap
::  entries and this is not one of them (a re-share of one it holds only
::  updates it)
++  host-full
  |=  [cur=shared host=@p pax=path]
  ^-  ?
  =/  n=@ud  0
  |-  ^-  ?
  ?~  cur  (gte n host-cap)
  ?.  =(host host.i.cur)  $(cur t.cur)
  ?:  =(pax pax.i.cur)  |
  $(cur t.cur, n +(n))
::  +dir-touch: is a folder notice `pax` at `mode` nothing new, given the
::  entry `hit` (+dir-cover) that covers it? The folder's own entry at the
::  same mode is, and so is a folder under a listed one at no wider a
::  mode. A sub-folder shared wider (edit under a folder read) is new: it
::  gets its own entry, as +holds-trim keeps it on the sending side.
++  dir-touch
  |=  [hit=(unit entry) pax=path mode=@t]
  ^-  ?
  ?~  hit  |
  ?:  =(pax pax.u.hit)  =(mode mode.u.hit)
  (lte (mode-rank mode) (mode-rank mode.u.hit))
::  +$  gmode: the grant modes there are. A mode is stored as a cord, and
::  'read' and 'edit' are these atoms, so a stored mode is checked by mold.
+$  gmode  ?(%read %edit)
::  +mode-ok: is a stored mode one of them
++  mode-ok  |=(md=* ^-(? ?=(gmode md)))
::  +clean-modes: a stored group-to-mode map with anything but read or
::  edit dropped: no grant, never a wider one. The caller logs a drop.
++  clean-modes
  |=  gs=(map @t @t)
  ^-  (map @t @t)
  %-  ~(gas by *(map @t @t))
  (skim ~(tap by gs) |=([g=@t md=@t] (mode-ok md)))
::  +clean-shared: the inbox's entries with a bad mode or path dropped
++  clean-shared
  |=  cur=shared
  ^-  shared
  (skim cur |=(e=entry &((mode-ok mode.e) (pax-ok pax.e))))
::  +del-entry: drop one [host pax].
++  del-entry
  |=  [cur=shared host=@p pax=path]
  ^-  shared
  %+  skip  cur
  |=(e=entry &(=(host.e host) =(pax.e pax)))
::  +$  banned: ships this ship refuses. A DENY list, and deny is the one thing
::  grubbery weirs cannot express. A weir is a SET of granted roads, unioned
::  across every usergroup a ship belongs to, so there is nowhere to write "not
::  this one". The banlist therefore lives here and is enforced by this app, at
::  the two places a foreign ship's identity is actually known:
::
::    - the shares inbox, which /public deliberately lets ANY ship poke
::    - any grant this app writes (per-ship share, or a group's ship list)
::
::  What it CANNOT do, and must not pretend to: stop a banned ship reading a
::  page you published. A published page's road sits in /public's peek set,
::  which means everyone, and clearweb has no ship identity at all. Banning is
::  about who can reach you and who can hold a grant. Unpublish to stop a
::  read.
+$  banned  (set @p)
::  +ban-cap: bound, same reasoning as +cap. A list the owner grows by hand,
::  but bounded so a runaway client cannot balloon the grub.
++  ban-cap  ^-(@ud 500)
::  +is-banned: the single predicate every enforcement point calls, so a new
::  call site cannot invent its own subtly different rule.
::  A moon is banned with its planet, since a planet mints moons at will.
++  is-banned
  |=  [bans=banned who=@p]
  ^-  ?
  ?|  (~(has in bans) who)
      (~(has in bans) (family who))
  ==
::  +family: whom a ship answers for in a quota or a ban. A moon answers
::  for its planet (its low 32 bits), and every comet for all comets: both
::  are minted at will, so a limit on one alone binds nothing. Any other
::  ship answers for itself. Sized by bytes, so no jael is needed.
++  family
  |=  who=@p
  ^-  @
  =/  w=@ud  (met 3 who)
  ?:  (gth w 8)  (bex 128)
  ?:  (gth w 4)  (end 5 who)
  who
::  +quota-family: whom a ship answers for in a per-author quota. As
::  +family, but each comet answers for itself: a comet reader cannot
::  share a quota with every other comet, and the page's overall cap
::  still bounds what all of them together can file. A ban still takes
::  +family, so banning the comets' family bans every comet at once.
++  quota-family
  |=  who=@p
  ^-  @
  ?:  (gth (met 3 who) 8)  who
  (family who)
::  +all-comets: the @p that stands for every comet in a ban, +family's
::  answer for a comet. Banning it bans them all.
++  all-comets  ^-(@p (bex 128))
::  +ban-full: is the banlist full for `who`: it holds +ban-cap ships and
::  `who` is not one of them
++  ban-full
  |=  [bans=banned who=@p]
  ^-  ?
  &(!(~(has in bans) who) (gte ~(wyt in bans) ban-cap))
::  +ban-drop: `ships` without any the bans cover (+is-banned): a banned
::  planet's moons, and every comet when the comets are banned, as well
::  as the ship itself
++  ban-drop
  |=  [bans=banned ships=(set @p)]
  ^-  (set @p)
  ?:  =(~ bans)  ships
  %-  ~(gas in *(set @p))
  (skip ~(tap in ships) |=(s=@p (is-banned bans s)))
::  +ban-groups: the auto-groups a ban takes away whole. +share-file and a
::  folder share name a ship's group after it (`<ship>.grp`, no sig), and a
::  later share merges into that group. A ban that only took the ship out
::  left the group's roads, so after an unban one share put every old
::  grant back, untold. So the group of each ship the bans cover
::  (+is-banned) goes, unless a member the bans do not cover is left in
::  it (the owner added one by hand, and it still needs the roads). Given
::  each top-level group's dir name and members, the group names to drop.
++  ban-groups
  |=  [bans=banned gs=(list [nom=@ta who=(set @p)])]
  ^-  (list @t)
  %+  murn  gs
  |=  [nom=@ta who=(set @p)]
  ^-  (unit @t)
  ?.  (grp-name nom)  ~
  =/  t=tape  (trip nom)
  =/  g=tape  (scag (sub (lent t) 4) t)
  =/  shp=(unit @p)  (slaw %p (crip ['~' g]))
  ?~  shp  ~
  ?.  (is-banned bans u.shp)  ~
  ?.  =(~ (ban-drop bans who))  ~
  `(crip g)
::
::  ==  comet guard  ==
::
::  Comets are free to mint, so a per-author quota alone binds nothing:
::  one person can be any number of authors. The guard bounds what all
::  comets together may file on one page (a rate cap over a rolling
::  window), and lets the owner hold or refuse comets per page. Planets
::  and moons never pass through it. One gate for every place a comet
::  writes (page comments, forum posts), so the rule cannot drift.
::
::  +$  comet-mode: a page's policy for comets. %open is the default.
+$  comet-mode  ?(%open %held %off)
::  +$  comet-page: what the gate needs to know of a page: its mode, and
::  when each comet write it accepted or held happened. Older stamps are
::  harmless: the gate counts only those inside the window.
+$  comet-page  [mode=comet-mode recent=(list @da)]
::  +$  comet-verdict: %ok to store, %held to queue for the owner,
::  %refused with words a reader can show.
+$  comet-verdict  $%([%ok ~] [%held ~] [%refused why=@t])
++  comet-cap     ^-(@ud 10)
++  comet-window  ^-(@dr ~h1)
++  comet-full-why  'Too many anonymous comments here right now, try again later'
++  comet-off-why   'Anonymous comments are off on this page'
::  +is-comet: sized by bytes, as +family is
++  is-comet  |=(who=@p ^-(? (gth (met 3 who) 8)))
::  +comet-mode-of: a stored mode, %open for anything unreadable
++  comet-mode-of
  |=  n=*
  ^-  comet-mode
  ?+(n %open %held %held, %off %off)
::  +comet-live: the stamps inside the window ending at now, newest first
++  comet-live
  |=  [recent=(list @da) now=@da]
  ^-  (list @da)
  =/  from=@da  ?:((lth now comet-window) *@da (sub now comet-window))
  (sort (skim recent |=(t=@da (gth t from))) gth)
::  +comet-gate: may `who` write on a page in state `pg`? Anyone but a
::  comet is %ok. A comet is refused on an %off page or over the cap,
::  held on a %held page, and %ok otherwise.
++  comet-gate
  |=  [pg=comet-page who=@p now=@da]
  ^-  comet-verdict
  ?.  (is-comet who)  [%ok ~]
  ?:  ?=(%off mode.pg)  [%refused comet-off-why]
  ?:  (gte (lent (comet-live recent.pg now)) comet-cap)
    [%refused comet-full-why]
  ?:(?=(%held mode.pg) [%held ~] [%ok ~])
::  +comet-full-until: when the page's cap frees, if it is at the cap now.
::  The cap-th newest stamp in the window leaves it a window after it came.
++  comet-full-until
  |=  [recent=(list @da) now=@da]
  ^-  (unit @da)
  =/  live=(list @da)  (comet-live recent now)
  ?.  (gte (lent live) comet-cap)  ~
  `(add (snag (dec comet-cap) live) comet-window)
::  +$  comet-row: one page's line in /pub/comets: its mode, and the unix
::  second its cap frees when it is at the cap.
+$  comet-row  [mode=comet-mode until=(unit @ud)]
::  +comets-cord: /pub/comets, one line per page whose comet policy is not
::  plain open, `<name> <mode>` or `<name> <mode> <until>`. A page not in
::  it is open, so a publisher without the grub reads as every page open.
++  comets-cord
  |=  rows=(map @t comet-row)
  ^-  @t
  =/  l=(list [n=@t r=comet-row])
    (sort ~(tap by rows) |=([a=[n=@t *] b=[n=@t *]] (aor n.a n.b)))
  %-  of-wain:format
  %+  murn  l
  |=  [n=@t r=comet-row]
  ^-  (unit @t)
  ?:  &(?=(%open mode.r) ?=(~ until.r))  ~
  :-  ~
  %-  crip
  ;:  weld  (trip n)  " "  (trip mode.r)
    ?~(until.r "" (weld " " ((d-co:co 1) u.until.r)))
  ==
::  +comets-rows: +comets-cord read back. A line that will not read is
::  dropped, and an unknown mode reads as %open.
++  comets-rows
  |=  c=@t
  ^-  (map @t comet-row)
  %-  ~(gas by *(map @t comet-row))
  %+  murn  (to-wain:format c)
  |=  l=@t
  ^-  (unit [@t comet-row])
  =/  r
    %+  rush  l
    ;~  plug
      (cook crip (plus ;~(less ace prn)))
      ;~(pfix ace sym)
      (punt ;~(pfix ace dem))
    ==
  ?~  r  ~
  `[-.u.r (comet-mode-of +<.u.r) +>.u.r]
::  +comet-full-mins: the whole minutes, rounded up and at least one, from
::  now until a cap that frees at unix second `until`; 0 once it has passed,
::  when the window has rolled over and the page is open again
++  comet-full-mins
  |=  [until=@ud now=@da]
  ^-  @ud
  =/  n=@ud  (unix-s now)
  ?.  (gth until n)  0
  (max 1 (div (add (sub until n) 59) 60))
::  +comet-full-words: what a reader shows at the cap, `mins` before it frees
++  comet-full-words
  |=  mins=@ud
  ^-  @t
  %-  crip
  "Too many anonymous comments here right now, try again in {((d-co:co 1) (max 1 mins))} min"
::  +unix-s: a date as unix seconds
++  unix-s  |=(d=@da ^-(@ud ?:((lth d ~1970.1.1) 0 (div (sub d ~1970.1.1) ~s1))))
::
::  ==  grant roads  ==
::
::  A grant is a road in a usergroup's weir. Roads are taken as nouns here,
::  as +lane-dirs:lattice-urls takes lanes, so the lib needs no tarball
::  types and runs offline. An absolute road is [%& lane], and a lane is
::  [%& path name] (a file) or [%| path] (a dir). A relative road grants
::  nothing in a group weir, which is read as written into each member's.
::
::  +grp-name: is this usergroups child a group? Grubbery's +find-groups
::  takes a child named *.grp as a group and recurses into any other.
++  grp-name
  |=  n=@ta
  ^-  ?
  =/  t=tape  (trip n)
  &((gth (lent t) 4) =(".grp" (slag (sub (lent t) 4) t)))
::  +road-lane: an absolute road's lane, as a file path or a dir path.
::  ~ for a relative road or any other shape.
++  road-lane
  |=  r=*
  ^-  (unit (each path path))
  =/  f  (mole |.(;;([%& %& p=path n=@ta] r)))
  ?^  f  `[%& (snoc p.u.f n.u.f)]
  =/  d  (mole |.(;;([%& %| p=path] r)))
  ?^  d  `[%| p.u.d]
  ~
::  +grant-covers: does road `r` grant the page whose dir is `pg`? A dir
::  road at or above the page does, and so does a file road on a file in
::  the page's dir or below. With mak (the make side), a dir road below
::  the page counts too, since it reaches the page's own grubs.
++  grant-covers
  |=  [r=* pg=path mak=?]
  ^-  ?
  =/  l  (road-lane r)
  ?~  l  |
  ?:  ?=(%& -.u.l)
    &((gth (lent p.u.l) (lent pg)) =(pg (scag (lent pg) p.u.l)))
  ?|  =(p.u.l (scag (lent p.u.l) pg))
      &(mak =(pg (scag (lent pg) p.u.l)))
  ==
::
::  ==  folder sharing  ==
::
::  A folder may carry a share setting (its `share-dir` grub) that every
::  page below it takes, at any depth, unless the page has one of its own
::  or is sensitive. The writer keeps the taken setting on the page as its
::  `share` grub, with a `share-via` grub naming the folder, so whatever
::  reads `share` needs no change. These are the pure halves of that.
::
::  +$  dir-mode: a share setting. On a folder, %private means none.
+$  dir-mode  ?(%private %shared %clearweb)
::  +dir-nearest: the nearest folder strictly above the page at `rel` whose
::  setting is not %private, from `dirs` (folder path to setting)
++  dir-nearest
  |=  [dirs=(map path dir-mode) rel=path]
  ^-  (unit [dir=path mode=dir-mode])
  ?~  rel  ~
  =/  up=path  (snip `path`rel)
  |-  ^-  (unit [dir=path mode=dir-mode])
  =/  hit=(unit dir-mode)  (~(get by dirs) up)
  ?:  &(?=(^ hit) !?=(%private u.hit))  `[up u.hit]
  ?~  up  ~
  $(up (snip `path`up))
::  +dir-target: what a page with no setting of its own takes: the nearest
::  folder's, and nothing when the page is sensitive (a folder rule never
::  shares one, it needs its own explicit setting)
++  dir-target
  |=  [dirs=(map path dir-mode) rel=path sens=?]
  ^-  (unit [dir=path mode=dir-mode])
  ?:  sens  ~
  (dir-nearest dirs rel)
::  +$  dir-step: what the writer does to one page. %keep: nothing. %set:
::  take `mode` from the folder at `dir`. %drop: unpublish and forget an
::  inherited setting.
+$  dir-step  $%([%keep ~] [%set dir=path mode=dir-mode] [%drop ~])
::  +dir-plan: the step for a page that holds `cur` (from `via` when that
::  is set, its own when `own`) given the folder target `tgt`. A page's
::  own setting always wins, so it is kept, and so is a page that already
::  holds what the folder gives.
++  dir-plan
  |=  [own=? via=(unit path) cur=dir-mode tgt=(unit [dir=path mode=dir-mode])]
  ^-  dir-step
  ?:  own  [%keep ~]
  ?~  tgt  ?~(via [%keep ~] [%drop ~])
  ?:  &(=(via `dir.u.tgt) =(cur mode.u.tgt))  [%keep ~]
  [%set dir.u.tgt mode.u.tgt]
::  +dir-effective: a page's setting, all told: its own, else the
::  folder's (+dir-target), else %private
++  dir-effective
  |=  [own=(unit dir-mode) dirs=(map path dir-mode) rel=path sens=?]
  ^-  dir-mode
  ?^  own  u.own
  =/  t  (dir-target dirs rel sens)
  ?~(t %private mode.u.t)
::  +sens-at: is the page at `rel` (under a folder) sensitive, from the
::  `sensitive` flags found in that folder's tree (`flags`, rel to flag)
::  and `base`, what the folder itself takes from above. The nearest flag
::  at or above the page wins, as +page-sensitive reads it.
++  sens-at
  |=  [flags=(map path ?) base=? rel=path]
  ^-  ?
  |-  ^-  ?
  =/  f=(unit ?)  (~(get by flags) rel)
  ?^  f  u.f
  ?~  rel  base
  $(rel (snip `path`rel))
::  +taint-dest: may a tainted key write the page: only one that is
::  sensitive, not published, and granted to no ship by hand. A tainted
::  key's writes must stay where its reading came from.
++  taint-dest
  |=  [sens=? pub=? granted=?]
  ^-  ?
  &(sens !pub !granted)
::  +pub-key-rel: a /pub/index key (/pub/<rel>/gmi) as the page's rel
++  pub-key-rel
  |=  k=path
  ^-  (unit path)
  ?.  ?=([%pub *] k)  ~
  =/  r=path  t.k
  ?~  r  ~
  ?.  =(%gmi (rear r))  ~
  =/  out=path  (snip `path`r)
  ?~(out ~ `out)
::  +$  dir-row: one line of a folder's index: a page directly in it, or a
::  folder below it, with when it (or its newest page) was last changed
+$  dir-row  [name=@ta page=? when=@da]
::  +dir-rows: a folder's index from the published pages `keys` (rel and
::  last change). Folders first, then pages, each by name, as the tree
::  sorts; `by-date` lists everything oldest to newest instead. A name can
::  be a page and a folder both (a page with pages under it).
++  dir-rows
  |=  [keys=(list [rel=path when=@da]) dir=path by-date=?]
  ^-  (list dir-row)
  =/  n=@ud  (lent dir)
  =|  pages=(map @ta @da)
  =|  dirs=(map @ta @da)
  |-  ^-  (list dir-row)
  ?^  keys
    =/  r=path  rel.i.keys
    ?.  &((gth (lent r) n) =(dir (scag n r)))  $(keys t.keys)
    =/  nom=@ta  (snag n r)
    ?:  =(+(n) (lent r))
      $(keys t.keys, pages (~(put by pages) nom when.i.keys))
    =/  had=@da  (~(gut by dirs) nom *@da)
    $(keys t.keys, dirs (~(put by dirs) nom (max had when.i.keys)))
  =/  fs=(list dir-row)
    (turn ~(tap by dirs) |=([k=@ta w=@da] [k | w]))
  =/  ps=(list dir-row)
    (turn ~(tap by pages) |=([k=@ta w=@da] [k & w]))
  =/  by-name  |=([a=dir-row b=dir-row] (aor name.a name.b))
  ?.  by-date
    (weld (sort fs by-name) (sort ps by-name))
  %+  sort  (weld fs ps)
  |=  [a=dir-row b=dir-row]
  ?:  =(when.a when.b)  (aor name.a name.b)
  (lth when.a when.b)
::
::  ==  page titles  ==
::
::  /pub/titles: each published page's title and when it last changed, for
::  a folder's index, one line a page: `<key>\t<unix-s>\t<title>`, the key
::  named as the revision list names it ('/site/a'). A cord under %noun, as
::  /pub/comments is, so a reader without lattice's marks reads it as text.
::  A folder shared with ships or groups keeps the same lines for its own
::  pages in its `dir-index` grub, which only they may read.
+$  title-row  [when=@ud title=@t]
::  +title-clean: a title fit for one field of a line: no tab or line
::  break, at most +title-cap bytes, cut where a character starts
++  title-cap  ^-(@ud 300)
++  title-clean
  |=  t=@t
  ^-  @t
  =/  c=tape
    %+  turn  (trip (utf8-cut title-cap t))
    |=(c=@tD ?:(|(=(c '\09') =(c '\0a') =(c '\0d')) ' ' c))
  (crip c)
::  +utf8-cut: `t` cut to at most `n` bytes, never inside a character. A
::  cut at a byte whose top bits are 10 (a continuation byte) backs up to
::  the byte that starts its character, so the cord stays valid UTF-8.
++  utf8-cut
  |=  [n=@ud t=@t]
  ^-  @t
  ?:  (lte (met 3 t) n)  t
  =/  k=@ud  n
  |-
  ?:  =(0 k)  ''
  ?.  =(2 (rsh [0 6] (cut 3 [k 1] t)))  (end [3 k] t)
  $(k (dec k))
::  +page-title: a page's display title, its first heading line without
::  its #s and the blanks after them, cut to +title-cap; `fallback` when
::  there is none. Gemtext and markdown both open a heading with '#'.
++  page-title
  |=  [body=@t fallback=@t]
  ^-  @t
  =/  lines=(list @t)  (to-wain:format body)
  |-  ^-  @t
  ?~  lines  fallback
  ?.  =('#' (end [3 1] i.lines))  $(lines t.lines)
  =/  t=tape  (trip (utf8-cut (add 64 title-cap) i.lines))
  =/  txt=tape
    |-  ^-  tape
    ?~  t  ~
    ?:  |(=('#' i.t) =(' ' i.t))  $(t t.t)
    t
  ?~(txt fallback (utf8-cut title-cap (crip `tape`txt)))
::  +beacon-next: the value a change beacon is bumped to. Strictly above
::  the last, so two bumps in one event (which share one `now`) still
::  differ and a keep-SSE news event fires for each.
++  beacon-next
  |=  [last=@ud now=@ud]
  ^-  @ud
  (max now +(last))
::  +corrupt-name: the name a grub that would not read is kept aside
::  under (in /corrupt), `<label>-corrupt-<time>`
++  corrupt-name
  |=  [label=@ta now=@da]
  ^-  @ta
  (crip "{(trip label)}-corrupt-{(slag 1 (scow %da now))}")
::  +titles-cord: the rows as the grub holds them, by key
++  titles-cord
  |=  rows=(map @t title-row)
  ^-  @t
  =/  l=(list [k=@t r=title-row])
    (sort ~(tap by rows) |=([a=[k=@t *] b=[k=@t *]] (aor k.a k.b)))
  %-  of-wain:format
  %+  turn  l
  |=  [k=@t r=title-row]
  (crip :(weld (trip k) "\09" ((d-co:co 1) when.r) "\09" (trip (title-clean title.r))))
::  +titles-rows: +titles-cord read back; a line that will not read is
::  dropped
++  titles-rows
  |=  c=@t
  ^-  (map @t title-row)
  %-  ~(gas by *(map @t title-row))
  %+  murn  (to-wain:format c)
  |=  l=@t
  ^-  (unit [@t title-row])
  =/  t=tape  (trip l)
  =/  i=(unit @ud)  (find "\09" t)
  ?~  i  ~
  =/  k=tape  (scag u.i t)
  ?~  k  ~
  =/  rest=tape  (slag +(u.i) t)
  =/  j=(unit @ud)  (find "\09" rest)
  ?~  j  ~
  =/  w=(unit @ud)  (rush (crip (scag u.j rest)) dem)
  ?~  w  ~
  `[(crip k) u.w (crip (slag +(u.j) rest))]
::  +titles-keys: the rows as +dir-rows takes them: each key's rel, and its
::  time as a date
++  titles-keys
  |=  rows=(map @t title-row)
  ^-  (list [rel=path when=@da])
  %+  murn  ~(tap by rows)
  |=  [k=@t r=title-row]
  ^-  (unit [rel=path when=@da])
  =/  p=(unit path)  (rush k stap)
  ?~  p  ~
  ?~  u.p  ~
  `[u.p (add ~1970.1.1 (mul when.r ~s1))]
::  +row-label: what a folder index shows for a row: a page's title from
::  `rows`, else its name; a folder's name and a slash
++  row-label
  |=  [rows=(map @t title-row) dir=path name=@ta page=?]
  ^-  tape
  ?.  page  (weld (trip name) "/")
  =/  r=(unit title-row)  (~(get by rows) (spat (snoc dir name)))
  ?:  |(?=(~ r) =('' title.u.r))  (trip name)
  (trip title.u.r)
::
::  ==  the reader of a peer's page  ==
::
::  +peer-titles-max: the most of a peer's /pub/titles or dir-index the
::  reader will parse. A real one is a line a page, far below this.
++  peer-titles-max  ^~((mul 1.024 1.024))
::  +peer-titles: a peer's titles cord as rows, none past
::  +peer-titles-max, and each title through +title-clean, since the
::  peer wrote it and +titles-rows keeps whatever follows the 2nd tab
++  peer-titles
  |=  c=@t
  ^-  (map @t title-row)
  ?:  (gth (met 3 c) peer-titles-max)  ~
  %-  ~(run by (titles-rows c))
  |=(r=title-row r(title (title-clean title.r)))
::  +peer-csp: the policy the reader serves a peer's page under. Nothing
::  loads from another host: no image, style, font, fetch or frame. The
::  chrome's own scripts and styles are inline, so those take
::  'unsafe-inline' (a peer's markup is escaped or framed sandboxed, and
::  this is the backstop). `outside` lets images load over https, for a
::  page the owner chose to load outside content on.
++  peer-csp
  |=  outside=?
  ^-  @t
  %-  crip
  ;:  weld
    "default-src 'self'; script-src 'self' 'unsafe-inline'; "
    "style-src 'self' 'unsafe-inline'; img-src 'self' data:"
    ?:(outside " https:" "")
    "; font-src 'self' data:; connect-src 'self'; media-src 'self' data:; "
    "object-src 'none'; base-uri 'self'"
  ==
::  +peer-doc: a reader document with `csp` in a <meta> at the top of its
::  head, and `foot` before its </body>. The meta keeps the policy when
::  the page cache (+page-cache-script) serves the copy without our
::  headers. A document not in the chrome's shape comes back unchanged.
++  peer-doc
  |=  [csp=@t foot=@t htm=@t]
  ^-  @t
  =/  hed=@t  '<!doctype html><html lang="en"><head><meta charset="utf-8">'
  =/  tal=@t  '</body></html>'
  =/  n=@ud  (met 3 hed)
  =/  e=@ud  (met 3 tal)
  =/  len=@ud  (met 3 htm)
  ?.  (gte len (add n e))  htm
  ?.  =(hed (end [3 n] htm))  htm
  ?.  =(tal (rsh [3 (sub len e)] htm))  htm
  =/  mid=@t  (cut 3 [n (sub len (add n e))] htm)
  %-  crip
  ;:  weld
    (trip hed)
    "<meta http-equiv=\"Content-Security-Policy\" content=\""
    (trip csp)  "\">"
    (trip mid)  (trip foot)  (trip tal)
  ==
::  +outside-key: a page's name in the `latout` cookie, the reader's list
::  of pages it loads outside content on. A hash, so the cookie holds no
::  address and needs no escaping.
++  outside-key
  |=  url=@t
  ^-  tape
  ((x-co:co 16) (end [3 8] (shax url)))
::  +outside-on: does the Cookie header `cookie` turn outside content on
::  for the page at `url`?
++  outside-on
  |=  [cookie=@t url=@t]
  ^-  ?
  =/  k=tape  (outside-key url)
  %+  lien  (split-on ';' (trip cookie))
  |=  i=tape
  =/  v=tape  |-(?~(i i ?:(=(' ' i.i) $(i t.i) i)))
  ?.  =("latout=" (scag 7 v))  |
  (lien (split-on '.' (slag 7 v)) |=(x=tape =(x k)))
::  +split-on: `t` cut at each `c`
++  split-on
  |=  [c=@tD t=tape]
  ^-  (list tape)
  =|  cur=tape
  =|  out=(list tape)
  |-  ^-  (list tape)
  ?~  t  (flop [(flop cur) out])
  ?:  =(c i.t)  $(t t.t, out [(flop cur) out], cur ~)
  $(t t.t, cur [i.t cur])
::
::  ==  folder grants to ships  ==
::
::  A folder shared with a ship keeps the grant in its `share-grants`
::  (group to mode). A page made or moved in takes the grants of every
::  folder above it, and notes them (`grant-via`), so moving it out takes
::  back exactly those and never a grant the page was given by hand.
::
::  +grants-above: what the page at `rel` takes from the folders above it
::  (`grants`, folder to group to mode), each group at its widest mode
++  grants-above
  |=  [grants=(map path (map @t @t)) rel=path]
  ^-  (map @t @t)
  ?~  rel  ~
  =/  dir=path  (snip `path`rel)
  =|  out=(map @t @t)
  |-  ^-  (map @t @t)
  =/  gs=(list [g=@t md=@t])  ~(tap by (~(gut by grants) dir ~))
  =.  out
    |-  ^-  (map @t @t)
    ?~  gs  out
    ?:  =('edit' (~(gut by out) g.i.gs ''))  $(gs t.gs)
    $(gs t.gs, out (~(put by out) g.i.gs md.i.gs))
  ?~  dir  out
  $(dir (snip `path`dir))
::  +revoke-groups: the groups a page leaving its folders loses its grant
::  in: those of the folders that granted it (`vias`), none for a page
::  whose grant is its own
++  revoke-groups
  |=  [grants=(map path (map @t @t)) vias=(list path)]
  ^-  (set @t)
  %-  ~(gas in *(set @t))
  %-  zing
  (turn vias |=(v=path ~(tap in ~(key by (~(gut by grants) v ~)))))
::  +mode-rank: how wide a grant mode is: none 0, read 1, edit 2
++  mode-rank
  |=  md=@t
  ^-  @ud
  ?:  =('edit' md)  2
  ?:(=('read' md) 1 0)
::  +mode-max: the wider of two grant modes, '' for none
++  mode-max
  |=  [a=@t b=@t]
  ^-  @t
  ?:((gte (mode-rank a) (mode-rank b)) a b)
::  +mode-min: the narrower of two grant modes
++  mode-min
  |=  [a=@t b=@t]
  ^-  @t
  ?:((lte (mode-rank a) (mode-rank b)) a b)
::  +own-infer: a page's own grant in a group (`own-grants`), as a folder
::  starts to share it: `own` as noted, never wider than the group now
::  grants it (`held`, so a group made again keeps no stale note), and
::  what it holds wider than its folders give it (`via`) was given by
::  hand, as before own grants were noted
++  own-infer
  |=  [own=@t held=@t via=@t]
  ^-  @t
  %+  mode-max  (mode-min own held)
  ?:((gth (mode-rank held) (mode-rank via)) held '')
::  +ungrant: what changes when the folder at `pax` stops being shared
::  with group `g`. Each page under it whose grant it made (`vias`, its
::  grant-via, names pax) is left with what it has from elsewhere: its
::  own grant in `g` (`own`, group to mode) and what another folder
::  still sharing with `g` gives it (`grants`, folder to group to mode,
::  pax's own included), the wider. Listed with that mode ('' none,
::  'read'), unless it is edit and nothing changes. Each folder index it
::  listed (`dirs`, pax and its subfolders) goes, less what another
::  folder sharing with `g` covers.
++  ungrant
  |=  $:  grants=(map path (map @t @t))  g=@t  pax=path
          pages=(list [rel=path vias=(list path) own=(map @t @t)])
          dirs=(list path)
      ==
  ^-  [pages=(list [rel=path md=@t]) dirs=(list path)]
  =/  rest=(map path (map @t @t))
    ?~  h=(~(get by grants) pax)  grants
    (~(put by grants) pax (~(del by u.h) g))
  =/  others=(list path)
    %+  murn  ~(tap by rest)
    |=  [f=path gs=(map @t @t)]
    ^-  (unit path)
    ?.  (~(has by gs) g)  ~
    `f
  =/  covered
    |=  p=path
    ^-  ?
    (lien others |=(f=path =(f (scag (lent f) p))))
  :_  (skip dirs covered)
  %+  murn  pages
  |=  [rel=path vias=(list path) own=(map @t @t)]
  ^-  (unit [path @t])
  ?~  (find ~[pax] vias)  ~
  =/  md=@t
    %+  mode-max  (~(gut by own) g '')
    (~(gut by (grants-above rest rel)) g '')
  ?:  =('edit' md)  ~
  `[rel md]
::
::  ==  followed folders  ==
::
::  A reader follows a folder another ship shared (urb://~host/<rel>/).
::  Each follow keeps the folder's pages as last read (`late`, key to
::  title row, the keys +titles-cord uses) and what the reader has seen
::  (`seen`, key to the change it saw). A page is new while its change is
::  later than the one seen, or it was never seen. `ok` is | while the
::  folder will not read (unshared), and the follow stays listed.
::
+$  fold  [host=@p rel=path seen=(map @t @ud) late=(map @t title-row) ok=? at=@da]
+$  folds  [%1 l=(list fold)]
::  +$  fold-action: what the writer does to the follows
+$  fold-action
  $%  [%add host=@p rel=path rows=(unit (map @t title-row))]
      [%read host=@p rel=path rows=(unit (map @t title-row))]
      [%del host=@p rel=path]
      [%seen host=@p rel=path key=@t]
  ==
::  +fold-act: one fold-action on the follows
++  fold-act
  |=  [fs=(list fold) act=fold-action now=@da]
  ^-  (list fold)
  ?-  -.act
    %add   (fold-add fs host.act rel.act rows.act now)
    %read  (fold-read fs host.act rel.act rows.act now)
    %del   (fold-del fs host.act rel.act)
    %seen  (fold-seen fs host.act rel.act key.act)
  ==
::  +fold-who: the folder an action names
++  fold-who
  |=  act=fold-action
  ^-  [host=@p rel=path]
  ?-  -.act
    %add   [host.act rel.act]
    %read  [host.act rel.act]
    %del   [host.act rel.act]
    %seen  [host.act rel.act]
  ==
::  +fold-cap: how many folders one ship may follow
++  fold-cap  ^-(@ud 200)
::  +fold-new: how many pages of a follow are new
++  fold-new
  |=  f=fold
  ^-  @ud
  %-  lent
  %+  skim  ~(tap by late.f)
  |=  [k=@t r=title-row]
  =/  s=(unit @ud)  (~(get by seen.f) k)
  |(?=(~ s) (gth when.r u.s))
::  +fold-get: the follow of `rel` on `host`, if any
++  fold-get
  |=  [fs=(list fold) host=@p rel=path]
  ^-  (unit fold)
  |-  ^-  (unit fold)
  ?~  fs  ~
  ?:  &(=(host host.i.fs) =(rel rel.i.fs))  `i.fs
  $(fs t.fs)
::  +fold-put: `f` in place of the follow it names, or added at the end
::  under +fold-cap
++  fold-put
  |=  [fs=(list fold) f=fold]
  ^-  (list fold)
  ?^  (fold-get fs host.f rel.f)
    (turn fs |=(o=fold ?:(&(=(host.o host.f) =(rel.o rel.f)) f o)))
  ?:  (gte (lent fs) fold-cap)  fs
  (snoc fs f)
::  +fold-del: the follows without `rel` on `host`
++  fold-del
  |=  [fs=(list fold) host=@p rel=path]
  ^-  (list fold)
  (skip fs |=(o=fold &(=(host host.o) =(rel rel.o))))
::  +fold-add: follow, the folder read as `rows`. What is there now counts
::  as seen: following marks nothing new. Following again keeps what was
::  seen.
++  fold-add
  |=  [fs=(list fold) host=@p rel=path rows=(unit (map @t title-row)) now=@da]
  ^-  (list fold)
  ?^  (fold-get fs host rel)  (fold-read fs host rel rows now)
  =/  late=(map @t title-row)  (fall rows ~)
  =/  seen=(map @t @ud)  (~(run by late) |=(r=title-row when.r))
  (fold-put fs [host rel seen late ?=(^ rows) now])
::  +fold-read: a fresh read of the folder. ~ is a folder that will not
::  read: the follow keeps its pages and turns unavailable.
++  fold-read
  |=  [fs=(list fold) host=@p rel=path rows=(unit (map @t title-row)) now=@da]
  ^-  (list fold)
  =/  f=(unit fold)  (fold-get fs host rel)
  ?~  f  fs
  ?~  rows  (fold-put fs u.f(ok |, at now))
  (fold-put fs u.f(late u.rows, ok &, at now))
::  +fold-seen: the page `key` is seen as it last read
++  fold-seen
  |=  [fs=(list fold) host=@p rel=path key=@t]
  ^-  (list fold)
  =/  f=(unit fold)  (fold-get fs host rel)
  ?~  f  fs
  =/  r=(unit title-row)  (~(get by late.u.f) key)
  ?~  r  fs
  (fold-put fs u.f(seen (~(put by seen.u.f) key when.u.r)))
::  +fold-under: the rows of `rows` (titles, every page a ship lists)
::  under the folder `rel`, at any depth
++  fold-under
  |=  [rows=(map @t title-row) rel=path]
  ^-  (map @t title-row)
  =/  pre=tape  (weld (trip (spat rel)) "/")
  =/  n=@ud  (lent pre)
  %-  ~(gas by *(map @t title-row))
  %+  skim  ~(tap by rows)
  |=  [k=@t r=title-row]
  =(pre (scag n (trip k)))
::  +fold-hit: the follows a share notice's page path falls under:
::  <base>/page/<rel...>/code, under a followed `rel` on that host. The
::  page dir is the first /page/ in the path; a later one is part of rel.
::  A folder's notice (<base>/page/<rel...>/dir-index) hits the follows
::  at, above and below the folder.
++  fold-hit
  |=  [fs=(list fold) host=@p pax=path]
  ^-  (list fold)
  =/  dir=?  (dir-key pax)
  =/  t=tape  (trip (spat ?:(dir (snip pax) pax)))
  =/  at=(unit @ud)  (find "/page/" t)
  ?~  at  ~
  =/  sub=tape  (weld (slag u.at t) ?:(dir "/" ""))
  %+  skim  fs
  |=  f=fold
  ?.  =(host host.f)  |
  ?~  rel.f  |
  =/  pre=tape  :(weld "/page" (trip (spat rel.f)) "/")
  ?|  =(pre (scag (lent pre) sub))
      ::  a folder notice (+dir-key) also reaches the follows below it
      &(dir =(sub (scag (lent sub) pre)))
  ==
::  +del-waits: how long a revoke notice (%del) that went unacked waits
::  before it is sent again, by the tries so far; ~ once it has had them
::  all, when it is dropped. About seven hours in all, so a peer offline
::  for an afternoon still hears it, and the queue stays bounded.
++  del-waits
  |=  tries=@ud
  ^-  (unit @dr)
  =/  l=(list @dr)  ~[~s30 ~m2 ~m10 ~h1 ~h6]
  ?:  (gte tries (lent l))  ~
  `(snag tries l)
::  +$  del-job: a revoke notice waiting for its ack: to whom, which page
+$  del-job  [who=@p pax=path]
::  +del-cap: the most revoke notices waiting at once
++  del-cap  ^-(@ud 2.000)
::  +grant-orphans: the folder grants a group's weir holds (`idx`: each
::  group and folder whose dir-index road it holds, and whether it may
::  edit) that no `share-grants` note covers (`recs`, folder to group to
::  mode: the folder's own or one above it, since a folder share holds
::  each subfolder's index too). A crash between the weir write and the
::  note leaves one, and an unshare then leaves every page under the
::  folder granted. Highest first, so a subfolder is covered by the note
::  its folder gets.
++  grant-orphans
  |=  [idx=(list [g=@t f=path ed=?]) recs=(map path (map @t @t))]
  ^-  (list [g=@t f=path md=@t])
  =/  l  (sort idx |=([a=[@t f=path ?] b=[@t f=path ?]] (lth (lent f.a) (lent f.b))))
  =|  out=(list [g=@t f=path md=@t])
  |-  ^-  (list [g=@t f=path md=@t])
  ?~  l  (flop out)
  =/  [g=@t f=path ed=?]  i.l
  =/  up=path  f
  =/  hit=?
    |-  ^-  ?
    ?:  (~(has by (~(gut by recs) up ~)) g)  &
    ?~  up  |
    $(up (snip `path`up))
  ?:  hit  $(l t.l)
  =/  md=@t  ?:(ed 'edit' 'read')
  %=  $
    l     t.l
    out   [[g f md] out]
    recs  (~(put by recs) f (~(put by (~(gut by recs) f ~)) g md))
  ==
::  +move-resumes: is a move from `pf` to `pt` asked at `now` the one the
::  /move-job note `job` says a reload left part way? Only then may it
::  finish without the destination checks a fresh move gets: its
::  destination is its own half-made copy. A note stays behind when the
::  reload falls between the source's delete and the note's clear, and
::  read as a resume for good it let the same move asked again later
::  overwrite whatever had been made at the destination since. So a note
::  counts for `ttl`, the time +move-guard holds saves out of the source.
++  move-resumes
  |=  [job=(unit [from=path to=path at=@da]) pf=path pt=path now=@da ttl=@dr]
  ^-  ?
  ?~  job  |
  ?.  &(=(pf from.u.job) =(pt to.u.job))  |
  (lte (sub now (min now at.u.job)) ttl)
::  +index-ups: the folders whose dir-index a page made in `dir` changes:
::  `dir` and each folder above it, from the highest that keeps an index
::  (`ixs` holds those) down. A folder's index lists every page under it,
::  so these are the only ones; a folder beside the path is unchanged. A
::  folder on the path with no index yet, under one that has, gets one,
::  as a whole rewrite of the higher folder would have given it.
++  index-ups
  |=  [dir=path ixs=(set path)]
  ^-  (list path)
  =/  ups=(list path)  (turn (gulf 0 (lent dir)) |=(n=@ud (scag n dir)))
  =/  on=?  |
  |-  ^-  (list path)
  ?~  ups  ~
  =.  on  |(on (~(has in ixs) i.ups))
  ?.  on  $(ups t.ups)
  [i.ups $(ups t.ups)]
::
::  ==  who holds which page  ==
::
::  A share notice goes to the ships a grant reaches and a revoke leaves.
::  Grants are unioned across every group a ship is in, so "reaches" is
::  read from all of them, before and after a change, and only the
::  difference is told: a ship that held a page already hears nothing.
::
::  +$  holds: per ship, each page code path it reads and its mode, and
::  each folder it reads whole by its dir-index path (+dir-key)
+$  holds  (map @p (map path @t))
::  +holds-of: the groups' ships, each with its page code paths: those it
::  reads (peek) and those it writes (make), and the folders it holds
::  (`dirs`, dir-index path to mode). Edit wins across groups. Then
::  +holds-trim, so a folder held whole stands for what is under it.
++  holds-of
  |=  gs=(list [who=(set @p) peek=(set path) make=(set path) dirs=(map path @t)])
  ^-  holds
  =|  acc=holds
  |-  ^-  holds
  ?~  gs  (~(run by acc) holds-trim)
  =/  ss=(list @p)  ~(tap in who.i.gs)
  =/  ps=(list [p=path md=@t])
    %+  weld  ~(tap by dirs.i.gs)
    %+  turn  ~(tap in peek.i.gs)
    |=(p=path [p ?:((~(has in make.i.gs) p) 'edit' 'read')])
  |-  ^-  holds
  ?~  ss  ^$(gs t.gs)
  =/  cur=(map path @t)  (~(gut by acc) i.ss ~)
  =/  l=(list [p=path md=@t])  ps
  |-  ^-  holds
  ?~  l
    ?~  cur  ^$(ss t.ss)
    ^$(ss t.ss, acc (~(put by acc) i.ss cur))
  ?:  =(`'edit' (~(get by cur) p.i.l))  $(l t.l)
  $(l t.l, cur (~(put by cur) p.i.l md.i.l))
::  +holds-trim: one ship's holds as its shared with me shows them. A
::  folder held whole is one entry, so a page under it, or a folder below
::  it, is dropped when the folder's mode is as wide: a page shared on its
::  own and in a shared folder shows once, as the folder. A page it may
::  edit in a folder it only reads keeps its own entry.
++  holds-trim
  |=  ps=(map path @t)
  ^-  (map path @t)
  =/  dirs=(list [d=path md=@t])
    %+  murn  ~(tap by ps)
    |=([p=path md=@t] ?.((dir-key p) ~ `[(snip p) md]))
  ?~  dirs  ps
  %-  ~(gas by *(map path @t))
  %+  skip  ~(tap by ps)
  |=  [p=path md=@t]
  =/  own=path  ?:((dir-key p) (snip p) p)
  %+  lien  `(list [d=path md=@t])`dirs
  |=  [d=path dm=@t]
  ?&  (gth (lent own) (lent d))
      =(d (scag (lent d) own))
      |(=('edit' dm) =('read' md))
  ==
::  +holds-diff: what to tell. Each page a ship reads now and did not, or
::  reads with a new mode, is an add; each it read and reads no more, a
::  del. Sorted, so the order is the same on every run.
++  holds-diff
  |=  [old=holds new=holds]
  ^-  [add=(list [who=@p pax=path mode=@t]) del=(list [who=@p pax=path])]
  =/  add=(list [who=@p pax=path mode=@t])
    %-  zing
    %+  turn  ~(tap by new)
    |=  [s=@p ps=(map path @t)]
    =/  was=(map path @t)  (~(gut by old) s ~)
    %+  murn  ~(tap by ps)
    |=  [p=path md=@t]
    ?:(=(`md (~(get by was) p)) ~ `[s p md])
  =/  del=(list [who=@p pax=path])
    %-  zing
    %+  turn  ~(tap by old)
    |=  [s=@p ps=(map path @t)]
    =/  now=(map path @t)  (~(gut by new) s ~)
    %+  murn  ~(tap in ~(key by ps))
    |=(p=path ?:((~(has by now) p) ~ `[s p]))
  :-  (sort add |=([a=[@p path @t] b=[@p path @t]] (aor a b)))
  (sort del |=([a=[@p path] b=[@p path]] (aor a b)))
--
