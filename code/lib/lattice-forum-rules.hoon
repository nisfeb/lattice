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
::  +rate-ok: may this ship act on this board now. mods always may; a
::  ship that never acted may; else the cooldown must have passed.
::
+$  limits  (map [@p board-name] [last=@da cooldown=@dr])
++  rate-limit-base  ~s10
++  rate-limit-max   ~m10
::
++  rate-ok
  |=  [who=@p name=board-name brd=board now=@da lim=limits]
  ^-  ?
  ?:  (is-mod who brd)  %.y
  =/  entry  (~(get by lim) [who name])
  ?~  entry  %.y
  (gte (sub now last.u.entry) cooldown.u.entry)
::
::  +rate-update: record an action. If a full 4x cooldown has passed
::  since the last, the cooldown resets to base; else it doubles, capped.
::
++  rate-update
  |=  [who=@p name=board-name now=@da lim=limits]
  ^-  limits
  =/  entry  (~(get by lim) [who name])
  =/  new-cd=@dr
    ?~  entry  rate-limit-base
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
