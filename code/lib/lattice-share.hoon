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
+$  action
  $%  [%add pax=path mode=@t]          ::  mode: 'read' | 'edit'
      [%del host=@p pax=path]
      [%put host=@p pax=path mode=@t]
  ==
+$  entry   [host=@p pax=path mode=@t when=@da]
+$  shared  (list entry)               ::  newest first
::  +cap: list bound. Anyone may poke the inbox, so without a cap a hostile
::  ship grows the grub without limit. With one they can at worst churn it.
++  cap  ^-(@ud 200)
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
--
