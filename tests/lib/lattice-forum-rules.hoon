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
--
