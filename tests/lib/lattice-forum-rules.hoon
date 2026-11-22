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
  [info (my ~[[~nec %poster] [~wet %mod]]) 1 ~ ~ ~ ~ '' ~ ~]
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
::  a name that is no board of ours is counted under one entry a family,
::  so a fresh name on each poke meets the cooldown and adds no entry
++  test-rate-key
  =/  t0=@da  ~2026.6.1
  =/  moon=@p  ~doznec-sampel-palnet
  =/  fam=@  ~sampel-palnet
  =/  ka  (rate-key:fr fam %aaa |)
  =/  kb  (rate-key:fr fam %bbb |)
  =/  l1  (rate-update:fr -.ka +.ka t0 ~)
  =/  l2  (rate-update:fr -.kb +.kb (add t0 ~s1) l1)
  ;:  weld
    (expect-eq !>(ka) !>(kb))
    (expect-eq !>([~sampel-palnet %$]) !>(ka))
    (expect-eq !>(1) !>(~(wyt by l2)))
    ::  the second name is inside the first one's cooldown
    (expect !>(?=(^ (~(get by l1) kb))))
    ::  a real board keeps an entry of its own, by family
    (expect-eq !>([~sampel-palnet %main]) !>((rate-key:fr fam %main &)))
    (expect !>(!=((rate-key:fr fam %main &) ka)))
    ::  another family is not held by it
    (expect !>(!=((rate-key:fr ~nec %aaa |) ka)))
    ::  a huge name is never stored
    =/  big=@tas  (crip (reap 5.000 'a'))
    (expect-eq !>(ka) !>((rate-key:fr fam big |)))
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
++  test-norm-tag
  ;:  weld
    (expect-eq !>(`%bug-report) !>((norm-tag:fr 'Bug Report')))
    (expect-eq !>(`%bug-report) !>((norm-tag:fr '  bug__report!! ')))
    (expect-eq !>(`%v2) !>((norm-tag:fr '2-v2')))
    (expect-eq !>(~) !>((norm-tag:fr '\e6\97\a5\e6\9c\ac\e8\aa\9e')))
    (expect-eq !>(~) !>((norm-tag:fr '!!!')))
    (expect-eq !>(~) !>((norm-tag:fr '')))
    (expect-eq !>(24) !>((met 3 (need (norm-tag:fr 'abcdefghijklmnopqrstuvwxyz-abc')))))
    ::  cut to 24, then the trailing dash goes
    (expect-eq !>(`%abcdefghijklmnopqrstuvw) !>((norm-tag:fr 'abcdefghijklmnopqrstuvw-xyz')))
  ==
::  every character is checked: each bad one follows a valid first letter
++  test-valid-tag
  ;:  weld
    (expect-eq !>(|) !>((valid-tag:fr 'aB')))
    (expect-eq !>(|) !>((valid-tag:fr 'a b')))
    (expect-eq !>(|) !>((valid-tag:fr 'a,b')))
    (expect-eq !>(|) !>((valid-tag:fr 'a<b')))
    (expect-eq !>(|) !>((valid-tag:fr 'a&b')))
    (expect-eq !>(|) !>((valid-tag:fr (crip (reap 25 'a')))))
    (expect-eq !>(|) !>((valid-tag:fr '')))
    (expect-eq !>(|) !>((valid-tag:fr '9x')))
    (expect-eq !>(&) !>((valid-tag:fr 'a')))
    (expect-eq !>(&) !>((valid-tag:fr 'a-1')))
    (expect-eq !>(&) !>((valid-tag:fr (crip (reap 24 'a')))))
  ==
++  test-norm-tags
  ;:  weld
    (expect-eq !>((sy ~[%a %b])) !>((norm-tags:fr ~['a' 'A' '' 'b' '!!'])))
    (expect-eq !>(5) !>(~(wyt in (norm-tags:fr ~['a' 'b' 'c' 'd' 'e' 'f']))))
    (expect-eq !>(|) !>((~(has in (norm-tags:fr ~['a' 'b' 'c' 'd' 'e' 'f'])) %f)))
  ==
++  test-clean-tags
  ;:  weld
    (expect-eq !>((sy ~[%ok])) !>((clean-tags:fr ;;((set @) (sy ~[%ok 'Bad Tag' '' '9x'])))))
    (expect-eq !>((sy ~[%a %b %c %d %e])) !>((clean-tags:fr (sy ~[%g %f %e %d %c %b %a]))))
    (expect-eq !>((sy ~[%ok])) !>((clean-tags:fr ;;((set @) (sy ~[%ok 'a,b' 'x y'])))))
  ==
++  test-can-tag
  ;:  weld
    (expect-eq !>(&) !>((can-tag:fr ~nec ~nec brd)))   ::  the author
    (expect-eq !>(&) !>((can-tag:fr ~wet ~nec brd)))   ::  a mod
    (expect-eq !>(&) !>((can-tag:fr ~zod ~nec brd)))   ::  the host
    (expect-eq !>(|) !>((can-tag:fr ~bus ~nec brd)))   ::  anyone else
  ==
--
