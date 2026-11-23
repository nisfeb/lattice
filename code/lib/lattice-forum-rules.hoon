::  lib/lattice-forum-rules: who may do what on a board, the size caps,
::  the per-ship rate limit, and the hot ranking. Ported from
::  furum-rules.hoon; posting is role, caps and rate only (no payment).
::
/<  *  /lib/lattice-forum-types.hoon
|%
++  get-role
  |=  [who=@p brd=board]
  ^-  role
  ?:  =(who host.info.brd)  %mod
  =/  explicit  (~(get by roles.brd) who)
  ?~  explicit  default-role.info.brd
  u.explicit
::
++  is-mod
  |=  [who=@p brd=board]
  ^-  ?
  =(%mod (get-role who brd))
::
++  can-post
  |=  [who=@p brd=board]
  ^-  ?
  =/  =role  (get-role who brd)
  ?|(=(role %mod) =(role %poster))
::
++  can-delete
  |=  [who=@p author=@p brd=board]
  ^-  ?
  ?|(=(who author) (is-mod who brd))
::
++  can-tag
  |=  [who=@p author=@p brd=board]
  ^-  ?
  (can-delete who author brd)
::
::  tags: [a-z][a-z0-9-]*, 1 to 24 characters, at most 5 per thread
::
++  max-tags  5
::
++  valid-tag
  |=  t=@
  ^-  ?
  =/  cs=(list @)  (rip 3 t)
  ?~  cs  |
  ?&  (lte (lent cs) 24)
      &((gte i.cs 'a') (lte i.cs 'z'))
      (levy (rip 3 t) |=(c=@ |(&((gte c 'a') (lte c 'z')) &((gte c '0') (lte c '9')) =(c '-'))))
  ==
::
::  +norm-tag: user text to a tag, or ~ when nothing usable is left
::
++  norm-tag
  |=  t=@t
  ^-  (unit tag)
  =/  cs=(list @)  (rip 3 (crip (cass (trip t))))
  =/  out=(list @)  ~
  |-  ^-  (unit tag)
  ?^  cs
    =/  c=@  i.cs
    ?:  |(&((gte c 'a') (lte c 'z')) &((gte c '0') (lte c '9')))
      $(cs t.cs, out `(list @)`[c out])
    ?:  ?~(out & =('-' i.out))  $(cs t.cs)
    $(cs t.cs, out `(list @)`['-' out])
  =.  out  (flop out)
  =.  out  (scag 24 (from-letter out))
  =.  out  (flop (trim-dashes (flop out)))
  ?~  out  ~
  `;;(tag (rap 3 (turn out |=(c=@ `@t`c))))
::
::  +from-letter: drop every character before the first letter
::
++  from-letter
  |=  cs=(list @)
  ^-  (list @)
  ?~  cs  ~
  ?:  &((gte i.cs 'a') (lte i.cs 'z'))  cs
  $(cs t.cs)
::
++  trim-dashes
  |=  cs=(list @)
  ^-  (list @)
  ?~  cs  ~
  ?:  =(i.cs '-')  $(cs t.cs)
  cs
::
++  norm-tags
  |=  ts=(list @t)
  ^-  (set tag)
  =/  out=(list tag)  ~
  |-  ^-  (set tag)
  ?~  ts  (silt out)
  ?:  =(max-tags (lent out))  (silt out)
  =/  n=(unit tag)  (norm-tag i.ts)
  ?~  n  $(ts t.ts)
  ?:  (~(has in (silt out)) u.n)  $(ts t.ts)
  $(ts t.ts, out [u.n out])
::
++  clean-tags
  |=  ts=(set @)
  ^-  (set tag)
  %-  silt
  %+  scag  max-tags
  %+  sort  (skim ~(tap in ts) valid-tag)
  aor
::
::  +sane-text: non-empty and at most max bytes
::
++  sane-text
  |=  [txt=@t max=@ud]
  ^-  ?
  &((gth (met 3 txt) 0) (lte (met 3 txt) max))
::
++  sane-post
  |=  [title=@t url=(unit @t) body=(unit @t)]
  ^-  ?
  ?&  (sane-text title 300)
      ?~(url & (sane-text u.url 2.048))
      ?~(body & (sane-text u.body 40.000))
  ==
::
++  sane-comment
  |=  body=@t
  ^-  ?
  (sane-text body 10.000)
::
::  +is-comet: a comet, by its size (more than 8 bytes), so no jael
::
++  is-comet
  |=  who=@p
  ^-  ?
  (gth (met 3 who) 8)
::
::  +comet-refusal: why a comet may not do `act` on `brd`, or ~ when it
::  may. A comet starts posts and replies on a public board whose owner
::  left comet posting on (`off` is the owner's switch), and nothing
::  else. Its vote is refused: a comet is free to mint, so a comet's
::  vote counts for nothing. Role and caps are checked after, as for
::  any remote poster.
::
++  comet-refusal
  |=  [act=action brd=board off=?]
  ^-  (unit @t)
  ?:  ?=(?(%upvote %downvote %remove-vote) -.act)
    `'forum: a comet cannot vote'
  ?.  ?=(?(%new-post %new-comment) -.act)
    `'forum: a comet can only post and reply'
  ?.  public.info.brd  `'forum: this board is private'
  ?:  off  `'forum: this board takes no posts from comets'
  ~
::
::  +rate-ok: may this ship act on this board now. mods always may; a
::  ship that never acted may; else the cooldown must have passed.
::
+$  limits  (map [@p board-name] [last=@da cooldown=@dr])
++  rate-limit-base  ~s10
++  rate-limit-max   ~m10
::
::  +rate-key: the entry a remote action is counted under. `fam` is whom
::  the sender answers for (+family:lattice-share), so a planet's moons
::  share one cooldown. The board name comes from the sender, so it keys
::  an entry only when it names a board we host (`known`). Every other
::  name shares one entry, under the empty name no board can have, or a
::  fresh name on each poke would never meet a cooldown and would add an
::  entry each time.
++  rate-key
  |=  [fam=@ name=board-name known=?]
  ^-  [@p board-name]
  [`@p`fam ?:(known name %$)]
++  rate-ok
  |=  [who=@p name=board-name brd=board now=@da lim=limits]
  ^-  ?
  ?:  (is-mod who brd)  %.y
  =/  entry  (~(get by lim) [who name])
  ?~  entry  %.y
  ?:  (lth now last.u.entry)  %.n
  (gte (sub now last.u.entry) cooldown.u.entry)
::
::  +rate-update: record an action. If a full 4x cooldown has passed
::  since the last, the cooldown resets to base; else it doubles, capped.
::  Other entries that have gone 4x their cooldown are dropped: one is
::  read just as a missing one is, and a ship naming a new board on each
::  poke would otherwise grow the map without end.
::
++  rate-update
  |=  [who=@p name=board-name now=@da lim=limits]
  ^-  limits
  =.  lim
    %-  ~(rep by lim)
    |=  [[k=[@p board-name] v=[last=@da cooldown=@dr]] acc=_lim]
    ?:  (lth now last.v)  acc
    ?.  (gte (sub now last.v) (mul 4 cooldown.v))  acc
    (~(del by acc) k)
  =/  entry  (~(get by lim) [who name])
  =/  new-cd=@dr
    ?~  entry  rate-limit-base
    ?:  (lth now last.u.entry)
      (min rate-limit-max (mul 2 cooldown.u.entry))
    ?:  (gte (sub now last.u.entry) (mul 4 cooldown.u.entry))
      rate-limit-base
    (min rate-limit-max (mul 2 cooldown.u.entry))
  (~(put by lim) [who name] [now new-cd])
::
::  +hot-score: HN-style, net votes over (hours + 2)^2, as an exact
::  integer pair [n d]. Compare by cross-multiplying, never in floats.
::
++  hot-score
  |=  [now=@da p=post]
  ^-  [n=@ud d=@ud]
  =/  up=@ud  ~(wyt in up-votes.p)
  =/  dn=@ud  ~(wyt in down-votes.p)
  =/  h=@ud  (add 2 (div ?:((gth now created.p) (sub now created.p) 0) ~h1))
  [?:((gte up dn) (sub up dn) 0) (mul h h)]
::
::  +hot-before: does a rank above b. Newer first at an equal score.
::
++  hot-before
  |=  [now=@da a=post b=post]
  ^-  ?
  =/  sa  (hot-score now a)
  =/  sb  (hot-score now b)
  =/  l=@ud  (mul n.sa d.sb)
  =/  r=@ud  (mul n.sb d.sa)
  ?.  =(l r)  (gth l r)
  (gth created.a created.b)
--
