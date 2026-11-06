::  Unit tests for /lib/lattice-forum-rules: roles, caps, the rate limit
::  and the hot ranking.
::
/+  *test, ft=lattice-forum-types, fr=lattice-forum-rules
|%
++  info
  ^-  board-info:ft
  [%main 'Main' 'a board' ~zod ~2026.1.1 %reader &]
++  brd
  ^-  board:ft
  [info (my ~[[~nec %poster] [~wet %mod]]) 1 ~ ~ ~ ~ '' ~]
++  mk-post
  |=  [id=@ud ups=@ud age=@dr]
  ^-  post:ft
  =/  voters=(set @p)  ?:(=(0 ups) ~ (silt (turn (gulf 1 ups) |=(i=@ud `@p`i))))
  [id ~zod 'hi' ~ ~ (sub ~2026.6.1 age) voters ~ 0]
++  test-roles
  ;:  weld
    (expect-eq !>(%mod) !>((get-role:fr ~zod brd)))
    (expect-eq !>(%mod) !>((get-role:fr ~wet brd)))
    (expect-eq !>(%reader) !>((get-role:fr ~marzod brd)))
    (expect-eq !>(|) !>((can-post:fr ~marzod brd)))
    (expect-eq !>(&) !>((can-post:fr ~nec brd)))
    (expect-eq !>(&) !>((can-post:fr ~zod brd)))
    (expect-eq !>(&) !>((can-delete:fr ~marzod ~marzod brd)))
    (expect-eq !>(|) !>((can-delete:fr ~marzod ~nec brd)))
    (expect-eq !>(&) !>((can-delete:fr ~wet ~nec brd)))
  ==
++  test-sane-post
  =/  big=@t  (crip (reap 40.001 'a'))
  =/  ok=@t   (crip (reap 40.000 'a'))
  ;:  weld
    (expect-eq !>(|) !>((sane-post:fr 'hi' ~ `big)))
    (expect-eq !>(&) !>((sane-post:fr 'hi' ~ `ok)))
    (expect-eq !>(|) !>((sane-post:fr '' ~ ~)))
    (expect-eq !>(|) !>((sane-post:fr (crip (reap 301 'a')) ~ ~)))
    (expect-eq !>(|) !>((sane-comment:fr (crip (reap 10.001 'a')))))
    (expect-eq !>(&) !>((sane-comment:fr 'ok')))
  ==
++  test-rate-limit
  =/  t0=@da  ~2026.6.1
  =/  l1  (rate-update:fr ~nec %main t0 ~)
  =/  l2  (rate-update:fr ~nec %main (add t0 ~s10) l1)
  ;:  weld
    (expect-eq !>(&) !>((rate-ok:fr ~nec %main brd t0 ~)))
    (expect-eq !>(|) !>((rate-ok:fr ~nec %main brd (add t0 ~s5) l1)))
    (expect-eq !>(&) !>((rate-ok:fr ~nec %main brd (add t0 ~s10) l1)))
    (expect-eq !>(&) !>((rate-ok:fr ~wet %main brd (add t0 ~s1) (rate-update:fr ~wet %main t0 ~))))
    ::  second act inside 4x cooldown doubles it
    (expect-eq !>(|) !>((rate-ok:fr ~nec %main brd (add t0 ~s25) l2)))
    (expect-eq !>(&) !>((rate-ok:fr ~nec %main brd (add t0 ~s30) l2)))
    ::  after 4x the cooldown it decays back to base
    =/  l3  (rate-update:fr ~nec %main (add t0 ~m10) l2)
    (expect-eq !>(`[(add t0 ~m10) ~s10]) !>((~(get by l3) [~nec %main])))
    ::  and is capped at ten minutes
    =/  big  (~(put by *limits:fr) [~nec %main] [t0 ~m8])
    =/  l4  (rate-update:fr ~nec %main (add t0 ~m9) big)
    (expect-eq !>(`[(add t0 ~m9) ~m10]) !>((~(get by l4) [~nec %main])))
  ==
::  a stale entry reads as a missing one, so an update drops it: a ship
::  naming a new board on every poke cannot grow the map
++  test-rate-limit-prunes
  =/  t0=@da  ~2026.6.1
  =/  l1  (rate-update:fr ~nec %a t0 ~)
  =/  l2  (rate-update:fr ~nec %b (add t0 ~s20) l1)
  =/  l3  (rate-update:fr ~nec %c (add t0 ~s45) l2)
  ;:  weld
    (expect-eq !>(2) !>(~(wyt by l2)))
    (expect-eq !>(2) !>(~(wyt by l3)))
    (expect-eq !>(~) !>((~(get by l3) [~nec %a])))
    (expect-eq !>(`[(add t0 ~s20) ~s10]) !>((~(get by l3) [~nec %b])))
    (expect-eq !>(&) !>((rate-ok:fr ~nec %a brd (add t0 ~s45) l3)))
  ==
++  test-hot-score
  =/  now=@da  ~2026.6.1
  =/  more   (mk-post 1 5 ~h1)
  =/  fewer  (mk-post 2 2 ~h1)
  =/  old    (mk-post 3 5 ~h48)
  =/  nv-new  (mk-post 4 0 ~h1)
  =/  nv-old  (mk-post 5 0 ~h5)
  ;:  weld
    ::  5 votes at 1h: 5 over (1+2)^2 = 9
    (expect-eq !>([5 9]) !>((hot-score:fr now more)))
    (expect-eq !>(&) !>((hot-before:fr now more fewer)))
    (expect-eq !>(|) !>((hot-before:fr now fewer more)))
    (expect-eq !>(&) !>((hot-before:fr now more old)))
    ::  equal score of 0: newer first
    (expect-eq !>(&) !>((hot-before:fr now nv-new nv-old)))
    (expect-eq !>(|) !>((hot-before:fr now nv-old nv-new)))
  ==
::  a comet posts and replies on a public board with comet posting on,
::  and nothing else: no vote, no edit, no private board, no board whose
::  owner turned comets off
++  test-comet-refusal
  =/  c=@p  (cat 7 ~sampel-palnet 3)
  =/  pub=board:ft  brd
  =/  priv=board:ft  pub(public.info |)
  =/  np=action:ft  [%new-post %main 'hi' ~ `'body']
  =/  nc=action:ft  [%new-comment %main 1 ~ 'reply']
  ;:  weld
    (expect-eq !>(&) !>((is-comet:fr c)))
    (expect-eq !>(|) !>((is-comet:fr ~sampel-palnet)))
    (expect-eq !>(|) !>((is-comet:fr (cat 5 ~sampel-palnet 7))))
    (expect-eq !>(~) !>((comet-refusal:fr np brd |)))
    (expect-eq !>(~) !>((comet-refusal:fr nc brd |)))
    (expect-eq !>(`'forum: a comet cannot vote') !>((comet-refusal:fr [%upvote %main [%post 1]] brd |)))
    (expect-eq !>(`'forum: a comet cannot vote') !>((comet-refusal:fr [%remove-vote %main [%post 1]] brd |)))
    (expect-eq !>(`'forum: a comet can only post and reply') !>((comet-refusal:fr [%delete-post %main 1] brd |)))
    (expect-eq !>(`'forum: this board is private') !>((comet-refusal:fr np priv |)))
    (expect-eq !>(`'forum: this board is private') !>((comet-refusal:fr nc priv |)))
    (expect-eq !>(`'forum: this board takes no posts from comets') !>((comet-refusal:fr np brd &)))
  ==
--
