::  lib/lattice-forum-board: a forum board in the ball. +load assembles
::  the in-memory $board from a board directory's grubs; +grubs splits one
::  back; +changed is what a write must put. Ported from furum-board.hoon,
::  cut to the lattice forum: the card is [%1 board-info], and there is
::  no payment and no follow.
::
::  Posts, threads and votes live in buckets of 100 post ids, one grub per
::  bucket, so a write rewrites one small noun and a reload clams a
::  hundred posts at a time (furum: 68s down to 8s at 2,500 posts).
::
/<  *  /lib/lattice-forum-types.hoon
|%
::  a grub under a board's directory: its path there (name last), and
::  the noun it holds
::
+$  grub  [pax=path val=*]
::
::  +bucket-size: post ids to a bucket
::
++  bucket-size  100
::
::  +bucket-of: a post's bucket number. Ids start at 1, so 1-100 are
::  bucket 0 and 101-200 bucket 1; id 0 is bucket 0 too.
::
++  bucket-of
  |=  id=post-id
  ^-  @ud
  ?:  =(0 id)  0
  (div (dec id) bucket-size)
::
::  +bucket: the grub name of a post's bucket, b0, b1, ...
::
++  bucket
  |=  id=post-id
  ^-  @ta
  (crip "b{(a-co:co (bucket-of id))}")
::
::  +bucket-pax: the path of the bucket grub for a post in a kind of
::  content (%posts, %threads or %votes)
::
++  bucket-pax
  |=  [dir=?(%posts %threads %votes) id=post-id]
  ^-  path
  /content/[dir]/(bucket id)
::
::  +bucket-put: one entry put into the bucket grub at pax, in the
::  accumulator of buckets being built
::
++  bucket-put
  |=  [acc=(map path (map * *)) pax=path key=* val=*]
  ^+  acc
  (~(put by acc) pax (~(put by (~(gut by acc) pax ~)) key val))
::
+$  parts
  $:  card=(unit board-info)
      roles=(map @p role)
      conf=board-conf
      pins=(set post-id)
      side=@t
      cores=(map post-id post-core)
      threads=(map post-id thread)
      votes=(map vote-target tally)
  ==
::  what the buckets hold: a post without its votes or comment count, a
::  thread's comments without their votes, a tally of a post or comment
::
+$  post-core     [id=post-id author=@p title=@t url=(unit @t) body=(unit @t) created=@da]
+$  comment-core  [id=comment-id parent=(unit comment-id) author=@p body=@t created=@da]
+$  thread        [next=comment-id comments=(map comment-id comment-core)]
+$  tally         [up=(set @p) down=(set @p)]
+$  board-conf    [next-post=post-id prune=(unit prune-config)]
::
::  +load: a board from its directory's grubs, or why not. A grub that no
::  shape fits is named, never skipped: the writer must not write back a
::  board it could read only part of. Grubs it doesn't know are ignored.
::
++  load
  |=  gs=(list grub)
  ^-  (each board @t)
  =|  acc=parts
  |-  ^-  (each board @t)
  ?~  gs
    ?~  card.acc  |+'no card'
    &+(assemble acc)
  =*  pax  pax.i.gs
  =*  val  val.i.gs
  =/  bad  |+(cat 3 'unreadable: ' (spat pax))
  ?+    pax  $(gs t.gs)
      [%pub %card ~]
    ?~  v=(mole |.(;;(card val)))  bad
    $(gs t.gs, card.acc `+.u.v)
  ::
      [%pub %roles ~]
    ?~  v=(mole |.(;;([%1 (map @p role)] val)))  bad
    $(gs t.gs, roles.acc +.u.v)
  ::
      [%pub %conf ~]
    ?~  v=(mole |.(;;([%1 board-conf] val)))  bad
    $(gs t.gs, conf.acc +.u.v)
  ::
      [%content %pins ~]
    ?~  v=(mole |.(;;([%1 (set post-id)] val)))  bad
    $(gs t.gs, pins.acc +.u.v)
  ::
      [%content %sidebar ~]
    ?~  v=(mole |.(;;([%1 @t] val)))  bad
    $(gs t.gs, side.acc +.u.v)
  ::
      [%content %posts @ ~]
    ?~  v=(mole |.(;;([%1 (map post-id post-core)] val)))  bad
    $(gs t.gs, cores.acc (~(uni by cores.acc) +.u.v))
  ::
      [%content %threads @ ~]
    ?~  v=(mole |.(;;([%1 (map post-id thread)] val)))  bad
    $(gs t.gs, threads.acc (~(uni by threads.acc) +.u.v))
  ::
      [%content %votes @ ~]
    ?~  v=(mole |.(;;([%1 (map vote-target tally)] val)))  bad
    $(gs t.gs, votes.acc (~(uni by votes.acc) +.u.v))
  ==
::
++  assemble
  |=  acc=parts
  ^-  board
  =/  posts=(map post-id post)
    %-  ~(urn by cores.acc)
    |=  [id=post-id c=post-core]
    ^-  post
    =/  t=tally  (~(gut by votes.acc) [%post id] *tally)
    =/  n=@ud  ?~(th=(~(get by threads.acc) id) 0 ~(wyt by comments.u.th))
    [id.c author.c title.c url.c body.c created.c up.t down.t n]
  =/  comments=(map post-id (map comment-id comment))
    %-  ~(urn by threads.acc)
    |=  [pid=post-id th=thread]
    %-  ~(urn by comments.th)
    |=  [cid=comment-id c=comment-core]
    ^-  comment
    =/  t=tally  (~(gut by votes.acc) [%comment pid cid] *tally)
    [id.c parent.c author.c body.c created.c up.t down.t]
  =|  brd=board
  %=  brd
    info              (need card.acc)
    roles             roles.acc
    next-post-id      next-post.conf.acc
    posts             posts
    comments          comments
    next-comment-ids  (~(run by threads.acc) |=(th=thread next.th))
    pinned            pins.acc
    sidebar           side.acc
    prune             prune.conf.acc
  ==
::
::  +grubs: a board as the grubs that hold it. A bucket with nothing in it
::  is left out; so is a post's thread before its first comment.
::
++  grubs
  |=  brd=board
  ^-  (map path *)
  =|  acc=(map path (map * *))
  =.  acc
    %+  roll  ~(tap by posts.brd)
    |=  [[id=post-id p=post] =_acc]
    =.  acc
      %-  bucket-put
      :^  acc  (bucket-pax %posts id)  id
      `post-core`[id.p author.p title.p url.p body.p created.p]
    ?:  &(=(~ up-votes.p) =(~ down-votes.p))  acc
    %-  bucket-put
    :^  acc  (bucket-pax %votes id)  [%post id]
    `tally`[up-votes.p down-votes.p]
  =.  acc
    %+  roll  ~(tap by next-comment-ids.brd)
    |=  [[pid=post-id next=comment-id] =_acc]
    ?:  =(0 next)  acc
    =/  cs=(map comment-id comment)  (~(gut by comments.brd) pid ~)
    =/  cores=(map comment-id comment-core)
      (~(run by cs) |=(c=comment `comment-core`[id.c parent.c author.c body.c created.c]))
    =.  acc
      (bucket-put acc (bucket-pax %threads pid) pid `thread`[next cores])
    %+  roll  ~(tap by cs)
    |=  [[cid=comment-id c=comment] =_acc]
    ?:  &(=(~ up-votes.c) =(~ down-votes.c))  acc
    %-  bucket-put
    :^  acc  (bucket-pax %votes pid)  [%comment pid cid]
    `tally`[up-votes.c down-votes.c]
  =/  out=(map path *)  (~(run by acc) |=(m=(map * *) [%1 m]))
  %-  ~(gas by out)
  ^-  (list [path *])
  :~  [/pub/card `card`[%1 info.brd]]
      [/pub/roles [%1 roles.brd]]
      [/pub/conf [%1 `board-conf`[next-post-id.brd prune.brd]]]
      [/content/pins [%1 pinned.brd]]
      [/content/sidebar [%1 sidebar.brd]]
  ==
::
::  +changed: the grubs a write must put to turn board `old` into `new`:
::  those `new` has that `old` lacks or holds differently. A bucket the
::  write didn't touch is not in it, so a write costs one bucket.
::
++  changed
  |=  [old=board new=board]
  ^-  (list grub)
  =/  was=(map path *)  (grubs old)
  %+  murn  ~(tap by (grubs new))
  |=  [pax=path val=*]
  ^-  (unit grub)
  ?:  =(`val (~(get by was) pax))  ~
  `[pax val]
::
::  +gone: the grubs a write must delete: those `old` had that `new`
::  lacks, such as a bucket whose last post was deleted
::
++  gone
  |=  [old=board new=board]
  ^-  (list path)
  =/  now=(map path *)  (grubs new)
  %+  murn  ~(tap by (grubs old))
  |=  [pax=path *]
  ^-  (unit path)
  ?:((~(has by now) pax) ~ `pax)
--
