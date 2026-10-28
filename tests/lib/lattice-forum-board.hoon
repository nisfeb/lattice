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
++  brd
  ^-  board:ft
  =/  ids=(list @ud)  ~[1 100 101 150]
  =/  posts=(map post-id:ft post:ft)
    (~(gas by *(map post-id:ft post:ft)) (turn ids |=(i=@ud [i (mk-post i 'hi')])))
  [info ~ 151 posts ~ ~ ~ '' ~]
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
--
