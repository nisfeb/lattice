::  Unit tests for /lib/lattice-comment, what a page's public thread shows.
::  Run with:  -test /=grubbery=/tests/lib/lattice-comment ~
::
::  The store keeps accepted comments under /comments/<page> and held comet
::  comments under /comments-held/<page>. Approval moves one across, a
::  rejection or the owner's delete drops it. The writer hands the filed
::  list and the page's comments flag to +public-thread, so each case below
::  is a page in that state.
::
/+  *test, lc=lattice-comment
|%
++  pla  ~sampel-palnet
++  mun  ~doznec-sampel-palnet
++  com  `@p`(add (bex 64) 12.345)
++  t1   ~2026.11.4..10.00.00
++  t2   ~2026.11.4..11.00.00
++  t3   ~2026.11.4..12.00.00
++  cp   `[id=@ta c=comment:lc]`[%a [pla t1 'from a planet']]
++  cm   `[id=@ta c=comment:lc]`[%b [mun t2 'from a moon']]
++  cc   `[id=@ta c=comment:lc]`[%c [com t3 'from a comet']]
++  ids
  |=  l=(list [id=@ta c=comment:lc])
  ^-  (list @ta)
  (turn l |=([id=@ta *] id))
::  open: planets, moons and an open page's comets all show, oldest first,
::  whatever order the store hands them in
++  test-open-shows-all-oldest-first
  %+  expect-eq  !>(`(list @ta)`~[%a %b %c])
  !>((ids (public-thread:lc & ~[cc cp cm])))
::  held: a held comet comment is not filed, so the thread has only the rest
++  test-held-not-shown
  =/  held=(list [id=@ta c=comment:lc])  ~[cc]
  ?>  ?=(^ held)
  %+  expect-eq  !>(`(list @ta)`~[%a %b])
  !>((ids (public-thread:lc & ~[cp cm])))
::  approved: approval files it, and it shows in its place by time
++  test-approved-shown
  %+  expect-eq  !>(`(list @ta)`~[%a %b %c])
  !>((ids (public-thread:lc & ~[cp cc cm])))
::  rejected: dropped from held and never filed, so never shown
++  test-rejected-not-shown
  %+  expect-eq  !>(`(list @ta)`~[%a])
  !>((ids (public-thread:lc & ~[cp])))
::  deleted: the owner's delete takes it out of the filed list
++  test-deleted-not-shown
  =/  filed=(list [id=@ta c=comment:lc])  ~[cp cm cc]
  =/  left  (skip filed |=([id=@ta *] =(%b id)))
  %+  expect-eq  !>(`(list @ta)`~[%a %c])
  !>((ids (public-thread:lc & left)))
::  comments off: nothing shows, and turning them on shows them again
++  test-off-hides-on-restores
  ;:  weld
    (expect-eq !>(`(list [id=@ta c=comment:lc])`~) !>((public-thread:lc | ~[cp cm cc])))
    (expect-eq !>(`(list @ta)`~[%a %b %c]) !>((ids (public-thread:lc & ~[cp cm cc]))))
  ==
::  the cap keeps the newest
++  test-cap-keeps-newest
  =/  many=(list [id=@ta c=comment:lc])
    %+  turn  (gulf 1 (add 5 thread-cap:lc))
    |=(i=@ud [(scot %ud i) [pla (add t1 (mul i ~s1)) 'x']])
  =/  out  (public-thread:lc & many)
  ;:  weld
    (expect-eq !>(thread-cap:lc) !>((lent out)))
    (expect-eq !>(`@ta`'6') !>(id:(snag 0 out)))
  ==
::  the cord reads back as it was written, and a bad cord reads as none
++  test-cord-round-trip
  =/  l=(list [id=@ta c=comment:lc])  (public-thread:lc & ~[cp cm cc])
  ;:  weld
    (expect-eq !>(l) !>((thread-rows:lc (thread-cord:lc l))))
    (expect-eq !>(`(list [id=@ta c=comment:lc])`~) !>((thread-rows:lc 'not json')))
    (expect-eq !>(`(list [id=@ta c=comment:lc])`~) !>((thread-rows:lc '{"v":1,"comments":[{"author":"nope","when":1,"body":"x"}]}')))
  ==
::  the index cord is a sorted line list, read back as a set
++  test-threads-cord
  =/  s=(set @t)  (silt `(list @t)`~['/b' '/a/x'])
  ;:  weld
    (expect-eq !>('/a/x\0a/b') !>((threads-cord:lc s)))
    (expect-eq !>(s) !>((thread-names:lc (threads-cord:lc s))))
    (expect-eq !>(`(set @t)`~) !>((thread-names:lc '')))
  ==
--
