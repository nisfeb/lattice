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
