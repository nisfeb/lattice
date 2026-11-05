::  Unit tests for /lib/lattice-notify: the held listing across pages and the
::  activity store (recording, read state, cap, reply targets).
::  Run with:  -test /=grubbery=/tests/lib/lattice-notify ~
::
/+  *test, ln=lattice-notify, lc=lattice-comment, ft=lattice-forum-types
|%
++  our  ~zod
++  pla  ~sampel-palnet
++  nec  ~nec
++  com  `@p`(add (bex 64) 12.345)
++  t1   ~2026.11.4..10.00.00
++  t2   ~2026.11.4..11.00.00
++  t3   ~2026.11.4..12.00.00
++  ids
  |=  l=(list [id=@ta i=item:ln])
  ^-  (list @ta)
  (turn l head)
++  it
  |=  [w=@da b=@t]
  ^-  item:ln
  (make:ln %comment w pla our 'notes/a' 0 '' b)
++  row
  |=  i=item:ln
  ^-  [id=@ta i=item:ln]
  [(item-id:ln i) i]
::  held: comments held on several pages list as one, newest first
++  test-held-across-pages-newest-first
  =/  held=(list [pax=path id=@ta c=comment:lc])
    :~  [/a %x [com t1 'one']]
        [/b/c %y [com t3 'three']]
        [/a %z [com t2 'two']]
    ==
  %+  expect-eq  !>(`(list @ta)`~[%y %z %x])
  !>((turn (held-sorted:ln held) |=([* id=@ta *] id)))
++  test-held-empty
  %+  expect-eq  !>(~)
  !>((held-sorted:ln ~))
::  recording: an item keeps its kind, author and clipped body
++  test-make-clips-body
  =/  long=@t  (crip (reap 1.000 'a'))
  =/  i=item:ln  (make:ln %reply t1 nec our 'main' 3 'Title' long)
  ;:  weld
    (expect-eq !>(%reply) !>(kind.i))
    (expect-eq !>(body-cap:ln) !>((met 3 body.i)))
    (expect-eq !>(3) !>(post.i))
  ==
::  the id is by content: the same item twice is one grub
++  test-item-id-stable
  %+  expect-eq  !>((item-id:ln (it t1 'hi')))
  !>((item-id:ln (it t1 'hi')))
::  read state: nothing read at first, then one by id, then all by mark
++  test-unread-by-id-and-mark
  =/  items=(list [id=@ta i=item:ln])  ~[(row (it t1 'a')) (row (it t2 'b')) (row (it t3 'c'))]
  =/  s0=seen:ln  [%1 *@da ~]
  =/  s1=seen:ln  (mark-ids:ln s0 ~[id:(row (it t2 'b'))] (sy (ids items)))
  =/  s2=seen:ln  (mark-all:ln t3)
  ;:  weld
    (expect-eq !>(3) !>((unread:ln s0 items)))
    (expect-eq !>(2) !>((unread:ln s1 items)))
    (expect-eq !>(0) !>((unread:ln s2 items)))
  ==
::  an item newer than the mark is unread again
++  test-new-after-mark-unread
  =/  items=(list [id=@ta i=item:ln])  ~[(row (it t1 'a')) (row (it t3 'c'))]
  %+  expect-eq  !>(1)
  !>((unread:ln (mark-all:ln t2) items))
::  the read set drops ids of items no longer stored
++  test-mark-ids-prunes
  =/  s=seen:ln  (mark-ids:ln [%1 *@da (sy ~[%gone])] ~[%a] (sy ~[%a %b]))
  %+  expect-eq  !>((sy ~[%a]))
  !>(ids.s)
::  newest first, and the cap culls the oldest
++  test-newest-first
  =/  items=(list [id=@ta i=item:ln])  ~[(row (it t1 'a')) (row (it t3 'c')) (row (it t2 'b'))]
  %+  expect-eq  !>(~[t3 t2 t1])
  !>((turn (newest-first:ln items) |=([* i=item:ln] when.i)))
++  test-overflow-oldest
  =/  items=(list [id=@ta i=item:ln])
    %+  turn  (gulf 1 (add item-cap:ln 2))
    |=(n=@ud (row (it (add t1 (mul n ~s1)) 'x')))
  =/  gone=(list @ta)  (overflow:ln items)
  ;:  weld
    (expect-eq !>(2) !>((lent gone)))
    (expect-eq !>(id:(row (it (add t1 ~s1) 'x'))) !>((rear gone)))
  ==
++  test-overflow-none-under-cap
  %+  expect-eq  !>(~)
  !>((overflow:ln ~[(row (it t1 'a'))]))
::  reply targets: a top-level comment concerns the post's author
++  brd
  ^-  board:ft
  =/  p=post:ft  [1 our 'Hello' ~ `'body' t1 ~ ~ 1]
  =/  c=comment:ft  [0 ~ pla 'first' t2 ~ ~]
  :*  [%main 'Main' '' our t1 %poster &]
      ~
      2
      (my ~[[1 p]])
      (my ~[[1 (my ~[[0 c]])]])
      (my ~[[1 1]])
      ~
      ''
      ~
  ==
++  test-reply-to-post
  %+  expect-eq  !>((sy ~[our]))
  !>((reply-targets:ln brd 1 ~ nec))
::  a reply under a comment concerns its author and the post's
++  test-reply-to-comment
  %+  expect-eq  !>((sy ~[our pla]))
  !>((reply-targets:ln brd 1 `0 nec))
::  never the replier itself
++  test-reply-not-self
  ;:  weld
    (expect-eq !>(~) !>((reply-targets:ln brd 1 ~ our)))
    (expect-eq !>((sy ~[our])) !>((reply-targets:ln brd 1 `0 pla)))
  ==
::  a post that is gone has no one to tell
++  test-reply-no-post
  %+  expect-eq  !>(~)
  !>((reply-targets:ln brd 9 ~ nec))
++  test-post-title
  ;:  weld
    (expect-eq !>('Hello') !>((post-title:ln brd 1)))
    (expect-eq !>('') !>((post-title:ln brd 9)))
  ==
::  an older build molds a note as [board reason] and must drop a reply
++  test-reply-note-old-mold-drops
  =/  n=reply-note:ln  [%reply-1 %main 1 'Hello' nec 'hi']
  %+  expect-eq  !>(~)
  !>((mole |.(;;([@tas @t] n))))
::  a followed folder's new pages: one item, its count and folder in the title
++  test-folder-item-title
  =/  i=item:ln  (folder-item:ln t1 pla /docs/notes 3)
  =/  o=item:ln  (folder-item:ln t1 pla /docs 1)
  ;:  weld
    (expect-eq !>(%folder) !>(kind.i))
    (expect-eq !>(pla) !>(who.i))
    (expect-eq !>(pla) !>(host.i))
    (expect-eq !>('/docs/notes') !>(where.i))
    (expect-eq !>(3) !>(post.i))
    (expect-eq !>('3 new pages in /docs/notes from ~sampel-palnet') !>(title.i))
    (expect-eq !>('1 new page in /docs from ~sampel-palnet') !>(title.o))
  ==
::  +folder-ids finds a folder's items only, not another folder's, another
::  host's, or another kind
++  test-folder-ids-per-folder
  =/  a=item:ln  (folder-item:ln t1 pla /docs 2)
  =/  items=(list [id=@ta i=item:ln])
    :~  (row a)
        (row (folder-item:ln t1 pla /other 1))
        (row (folder-item:ln t1 nec /docs 1))
        (row (make:ln %comment t1 pla pla '/docs' 0 '' 'x'))
    ==
  %+  expect-eq  !>(~[(item-id:ln a)])
  !>((folder-ids:ln items pla /docs))
::  coalescing: pages arriving over two reads leave one unread item with the
::  latest count, and marking the folder's ids read clears it
++  test-folder-coalesces-and-reads
  =/  r1=(list [id=@ta i=item:ln])  ~[(row (folder-item:ln t1 pla /docs 2))]
  =/  gone=(set @ta)  (sy (folder-ids:ln r1 pla /docs))
  =/  r2=(list [id=@ta i=item:ln])
    :-  (row (folder-item:ln t2 pla /docs 5))
    (skip r1 |=([id=@ta *] (~(has in gone) id)))
  =/  s0=seen:ln  (mark-all:ln t1)
  =/  s1=seen:ln  (mark-ids:ln s0 (folder-ids:ln r2 pla /docs) (sy (ids r2)))
  ;:  weld
    (expect-eq !>(1) !>((lent r2)))
    (expect-eq !>(5) !>(post.i:(snag 0 r2)))
    (expect-eq !>(1) !>((unread:ln s0 r2)))
    (expect-eq !>(0) !>((unread:ln s1 r2)))
  ==
--
