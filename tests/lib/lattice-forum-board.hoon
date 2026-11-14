::  Unit tests for /lib/lattice-forum-board: posts bucket by 100 ids, and
::  +load puts a board back together from its grubs.
::
/+  *test, ft=lattice-forum-types, fb=lattice-forum-board
|%
++  info
  ^-  board-info:ft
  [%main 'Main' 'a board' ~zod ~2026.1.1 %poster &]
++  mk-post
  |=  [id=@ud title=@t]
  ^-  post:ft
  [id ~zod title ~ ~ ~2026.1.1 ~ ~ 0]
++  pst  (mk-post 1 'hi')
++  cor  `post-core:fb`[1 ~zod 'hi' ~ ~ ~2026.1.1]
++  brd
  ^-  board:ft
  =/  ids=(list @ud)  ~[1 100 101 150]
  =/  posts=(map post-id:ft post:ft)
    (~(gas by *(map post-id:ft post:ft)) (turn ids |=(i=@ud [i (mk-post i 'hi')])))
  [info ~ 151 posts ~ ~ ~ '' ~ ~]
++  test-bucket-of
  ;:  weld
    (expect-eq !>(0) !>((bucket-of:fb 1)))
    (expect-eq !>(0) !>((bucket-of:fb 100)))
    (expect-eq !>(1) !>((bucket-of:fb 101)))
    (expect-eq !>(1) !>((bucket-of:fb 200)))
    (expect-eq !>(2) !>((bucket-of:fb 201)))
    (expect-eq !>(`@ta`'b1') !>((bucket:fb 101)))
  ==
++  test-grubs-bucket-split
  =/  g  (grubs:fb brd)
  ;:  weld
    (expect-eq !>(&) !>((~(has by g) /content/posts/b0)))
    (expect-eq !>(&) !>((~(has by g) /content/posts/b1)))
    (expect-eq !>(|) !>((~(has by g) /content/posts/b2)))
  ==
++  test-load-roundtrip
  =/  gs=(list grub:fb)  ~(tap by (grubs:fb brd))
  =/  r  (load:fb gs)
  ?>  ?=(%& -.r)
  ;:  weld
    (expect-eq !>(`(list @ud)`~[1 100 101 150]) !>(`(list @ud)`(sort ~(tap in ~(key by posts.p.r)) lth)))
    (expect-eq !>(brd) !>(p.r))
  ==
++  test-load-needs-card
  (expect-eq !>(`(each board:ft @t)`|+'no card') !>((load:fb ~)))
++  test-load-names-bad-grub
  =/  r  (load:fb ~[[/pub/roles 'junk']])
  (expect-eq !>(`(each board:ft @t)`|+'unreadable: /pub/roles') !>(r))
++  test-changed-one-bucket
  =/  b=board:ft  brd
  =/  edited=board:ft
    b(posts (~(put by posts.b) 150 (mk-post 150 'new')))
  =/  gutted=board:ft
    b(posts (~(del by (~(del by posts.b) 101)) 150))
  ;:  weld
    (expect-eq !>(`(list path)`~[/content/posts/b1]) !>((turn (changed:fb b edited) |=(g=grub:fb pax.g))))
    (expect-eq !>(`(list grub:fb)`~) !>((changed:fb b b)))
    (expect-eq !>(`(list path)`~) !>((gone:fb b b)))
    (expect-eq !>(`(list path)`~[/content/posts/b1]) !>((gone:fb b gutted)))
  ==
::  a board written before tags loads, with no marker
++  test-load-no-tags
  =/  r  (load:fb ~[[/pub/card [%1 info]] [/content/posts/b0 [%1 (my ~[[1 cor]])]]])
  ?>  ?=(%& -.r)
  (expect-eq !>(*(unit (map post-id:ft (set tag:ft)))) !>(tags.p.r))
::  the marker alone: an empty tags grub
++  test-load-empty-tags
  =/  r  (load:fb ~[[/pub/card [%1 info]] [/content/tags [%1 ~]]])
  ?>  ?=(%& -.r)
  (expect-eq !>(`(unit (map post-id:ft (set tag:ft)))`[~ ~]) !>(tags.p.r))
::  tags round-trip through +grubs and +load
++  test-tags-round-trip
  =/  b=board:ft  brd
  =.  b  b(posts (my ~[[1 pst]]), tags `(my ~[[1 (sy ~[%bug %idea])]]))
  =/  r  (load:fb ~(tap by (grubs:fb b)))
  ?>  ?=(%& -.r)
  (expect-eq !>(tags.b) !>(tags.p.r))
::  no marker in memory, no grub written
++  test-grubs-no-marker
  (expect-eq !>(|) !>((~(has by (grubs:fb brd)) /content/tags)))
::  tags for a post that is gone are not written back
++  test-grubs-drop-stale
  =/  b=board:ft  brd
  =.  b  b(tags `(my ~[[9 (sy ~[%bug])]]))
  (expect-eq !>([%1 ~]) !>((~(got by (grubs:fb b)) /content/tags)))
::  +changed and +gone across tag transitions: the marker's arrival and a
::  post's removal write the tags grub, no change leaves it, and no write
::  deletes it
++  test-changed-tags
  =/  bare=board:ft  brd
  =/  tagged=board:ft  bare(tags `(my ~[[1 (sy ~[%bug])] [150 (sy ~[%idea])]]))
  =/  less=board:ft  tagged(posts (~(del by posts.tagged) 1), tags `(my ~[[150 (sy ~[%idea])]]))
  =/  names  |=(gs=(list grub:fb) (turn gs |=(g=grub:fb pax.g)))
  =/  pairs=(list [board:ft board:ft])  ~[[bare tagged] [tagged less] [tagged tagged]]
  ;:  weld
    ::  null to set
    (expect-eq !>(&) !>(?=(^ (find ~[/content/tags] (names (changed:fb bare tagged))))))
    (expect-eq !>(`(list path)`~) !>((gone:fb bare tagged)))
    ::  set to set, a post removed
    (expect-eq !>(&) !>(?=(^ (find ~[/content/tags] (names (changed:fb tagged less))))))
    ::  unchanged
    (expect-eq !>(`(list path)`~) !>((names (changed:fb tagged tagged))))
    (expect-eq !>(`(list path)`~) !>((gone:fb tagged tagged)))
    ::  +gone never names the tags grub
    %+  expect-eq  !>(|)
    !>((lien pairs |=([o=board:ft n=board:ft] ?=(^ (find ~[/content/tags] (gone:fb o n))))))
  ==
::  a tags grub of the wrong shape names itself, as the other grubs do
++  test-load-bad-tags
  =/  r  (load:fb ~[[/pub/card [%1 info]] [/content/tags 'junk']])
  (expect-eq !>(`(each board:ft @t)`|+'unreadable: /content/tags') !>(r))
--
