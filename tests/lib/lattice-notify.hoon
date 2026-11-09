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
::  an item from source `n` (a ship of its own), at t1 plus n seconds
++  from
  |=  [n=@ud src=@p]
  ^-  item:ln
  (make:ln %comment (add t1 (mul n ~s1)) src our 'notes/a' 0 '' 'x')
++  test-overflow-oldest
  =/  items=(list [id=@ta i=item:ln])
    %+  turn  (gulf 1 (add item-cap:ln 2))
    |=(n=@ud (row (from n `@p`(add 256 n))))
  =/  gone=(list @ta)  (overflow:ln items)
  ;:  weld
    (expect-eq !>(2) !>((lent gone)))
    (expect-eq !>(id:(row (from 1 `@p`257))) !>((rear gone)))
  ==
::  one source flooding the store loses its own oldest, never another's
++  test-overflow-per-source
  =/  flood=(list [id=@ta i=item:ln])
    (turn (gulf 1 (add item-cap:ln 10)) |=(n=@ud (row (from (add 10 n) nec))))
  =/  others=(list [id=@ta i=item:ln])
    ~[(row (from 1 pla)) (row (from 2 ~bus))]
  =/  gone=(set @ta)  (silt (overflow:ln (weld others flood)))
  ;:  weld
    (expect-eq !>(%.n) !>((~(has in gone) id:(row (from 1 pla)))))
    (expect-eq !>(%.n) !>((~(has in gone) id:(row (from 2 ~bus)))))
    (expect-eq !>((sub (add item-cap:ln 10) source-cap:ln)) !>(~(wyt in gone)))
    ::  the flood's newest stay
    %+  expect-eq  !>(%.n)
    !>((~(has in gone) id:(row (from (add 10 (add item-cap:ln 10)) nec))))
  ==
::  a remote reply is its host's, whoever it names
++  test-source-of-remote
  =/  r=item:ln  (make:ln %remote t1 pla nec 'b' 1 '' 'x')
  ;:  weld
    (expect-eq !>(nec) !>((source-of:ln r)))
    (expect-eq !>(pla) !>((source-of:ln (it t1 'a'))))
  ==
::  the note gate: note-cap an hour per sender, then held and counted,
::  and free again once the window passes
++  test-note-gate-cap
  =/  h=note-hits:ln  ~
  =/  n=@ud  0
  |-
  ?.  =(n note-cap:ln)
    =/  g  (note-gate:ln h nec (add t1 (mul n ~s1)))
    ?.  ok.g  (expect-eq !>(%.y) !>(ok.g))
    $(n +(n), h hits.g)
  =/  over  (note-gate:ln h nec (add t1 ~m30))
  =/  over2  (note-gate:ln hits.over nec (add t1 ~m31))
  =/  other  (note-gate:ln hits.over2 pla (add t1 ~m31))
  =/  later  (note-gate:ln hits.over2 nec (add t1 ~h2))
  ;:  weld
    (expect-eq !>([%.n 1]) !>([ok.over over.over]))
    (expect-eq !>([%.n 2]) !>([ok.over2 over.over2]))
    (expect-eq !>(%.y) !>(ok.other))
    (expect-eq !>([%.y 0]) !>([ok.later over.later]))
    ::  a sender with nothing in the window is dropped from the state
    (expect-eq !>(~[nec]) !>(~(tap in ~(key by hits.later))))
  ==
::  the held count is one item per sender, found again by +flood-ids
++  test-flood-item
  =/  f=item:ln  (flood-item:ln t2 nec %b 3 7)
  =/  items=(list [id=@ta i=item:ln])
    ~[(row f) (row (make:ln %remote t1 pla nec 'b' 3 'Post' 'x')) (row (it t1 'a'))]
  ;:  weld
    (expect-eq !>(~[(item-id:ln f)]) !>((flood-ids:ln items nec)))
    (expect-eq !>(~) !>((flood-ids:ln items pla)))
    %+  expect-eq  !>('7 notes from ~nec held back: it sent more than 30 in an hour')
    !>(body.f)
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
::  +move-items: our page's comment items follow it, a page under it
::  too, and nothing else moves
++  test-move-items
  =/  t0  ~2026.1.1
  =/  c1  (make:ln %comment t0 ~bus ~zod 'a/b' 0 '' 'hi')
  =/  c2  (make:ln %comment t0 ~bus ~zod 'a/b/c' 0 '' 'hi')
  =/  c3  (make:ln %comment t0 ~bus ~zod 'a/bc' 0 '' 'hi')
  =/  c4  (make:ln %comment t0 ~bus ~nec 'a/b' 0 '' 'hi')
  =/  r1  (make:ln %reply t0 ~bus ~zod 'a/b' 1 '' 'hi')
  =/  got  (move-items:ln ~[[%x1 c1] [%x2 c2] [%x3 c3] [%x4 c4] [%x5 r1]] ~zod 'a/b' 'd')
  %+  expect-eq
    !>(`(list [@ta item:ln])`~[[%x1 c1(where 'd')] [%x2 c2(where 'd/c')]])
  !>(got)
::  a mode change or a revoke lists, read from the start; a new share
::  and an ask count as unread
++  test-quiet-kinds-read
  =/  s=seen:ln  [%1 ~2020.1.1 ~]
  =/  at=@da  ~2026.11.8
  =/  mk  |=(k=kind:ln (make:ln k at ~nec ~nec '/apps/x/page/a/code' 0 'a' 'b'))
  ;:  weld
    (expect-eq !>(&) !>((is-read:ln s 'x' (mk %reshare))))
    (expect-eq !>(&) !>((is-read:ln s 'x' (mk %unshare))))
    (expect-eq !>(|) !>((is-read:ln s 'x' (mk %share))))
    (expect-eq !>(|) !>((is-read:ln s 'x' (mk %ask))))
    (expect-eq !>(|) !>((is-read:ln s 'x' (mk %asked))))
    %+  expect-eq  !>(1)
    !>((unread:ln s ~[['a' (mk %share)] ['b' (mk %reshare)] ['c' (mk %unshare)]]))
  ==
--
