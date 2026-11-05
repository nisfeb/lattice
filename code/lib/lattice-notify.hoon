::  /lib/lattice-notify: the owner's inbox, held comet comments and activity.
::
::  Held comet comments live under /comments-held/<page>/<id> and are listed
::  across every page by +held-sorted. Activity is a small store of items,
::  one grub each under /notify/items/<id>: a comment from another ship on
::  one of our pages, a reply to our post or comment on a board we host,
::  and a reply on another ship's board that its host told us about. Read
::  state is one grub, /notify/seen: a high-water mark (mark all read) and
::  the ids read one by one since. Pure here, so the suites can test it.
::
/<  lc  /lib/lattice-comment.hoon
/<  ft  /lib/lattice-forum-types.hoon
|%
::  +$  kind: what an item is about
::    %comment  a comment from another ship on one of our pages
::    %reply    a reply to our post or comment on a board we host
::    %remote   a reply to our post or comment on another ship's board,
::              told to us by its host (+reply-note)
::    %folder   reserved for "a followed folder has new pages" (the
::              follow-a-folder work). Nothing records it yet: a recorder
::              files an item of this kind with +make and the inbox shows it.
+$  kind  ?(%comment %reply %remote %folder)
::  +$  item: one activity item. `host` is the ship it happened on (us for
::  our own pages and boards), `where` a page path or a board name, `post`
::  the forum post id (0 for a page), `title` the post title when known.
+$  item
  $:  %1
      =kind
      when=@da
      who=@p
      host=@p
      where=@t
      post=@ud
      title=@t
      body=@t
  ==
::  +$  seen: read state. An item is read when it is no newer than `mark`
::  or its id is in `ids`.
+$  seen  [%1 mark=@da ids=(set @ta)]
::  +$  reply-note: what a host pokes a poster, under the %forum-note mark
::  its refusal notes ride. A build before this one molds a note as
::  [board reason] and drops this shape (its tail is a cell, not a cord).
+$  reply-note  [%reply-1 board=@tas post=@ud title=@t who=@p body=@t]
::  +item-cap: activity items kept, newest first. Remote ships can add to
::  the store, so it is bounded on write.
++  item-cap  ^-(@ud 300)
::  +body-cap: bytes of a body kept in an item, a preview not a copy
++  body-cap  ^-(@ud 280)
::  +make: an item, its body clipped
++  make
  |=  [=kind when=@da who=@p host=@p where=@t post=@ud title=@t body=@t]
  ^-  item
  [%1 kind when who host where post (clip title) (clip body)]
++  clip
  |=  t=@t
  ^-  @t
  ?:  (lte (met 3 t) body-cap)  t
  (end [3 body-cap] t)
::  +item-id: an item's grub name, by its content
++  item-id
  |=  i=item
  ^-  @ta
  (scot %uv (sham i))
::  +is-read: whether an item counts as read
++  is-read
  |=  [s=seen id=@ta i=item]
  ^-  ?
  |((lte when.i mark.s) (~(has in ids.s) id))
::  +unread: how many of `items` are unread
++  unread
  |=  [s=seen items=(list [id=@ta i=item])]
  ^-  @ud
  %-  lent
  %+  skip  items
  |=([id=@ta i=item] (is-read s id i))
::  +newest-first: items by time, newest first, ties by id so the order is
::  the same on every build
++  newest-first
  |=  items=(list [id=@ta i=item])
  ^-  (list [id=@ta i=item])
  %+  sort  items
  |=  [a=[id=@ta i=item] b=[id=@ta i=item]]
  ?.  =(when.i.a when.i.b)  (gth when.i.a when.i.b)
  (aor id.a id.b)
::  +overflow: the ids past +item-cap, oldest, for the writer to cull
++  overflow
  |=  items=(list [id=@ta i=item])
  ^-  (list @ta)
  (turn (slag item-cap (newest-first items)) head)
::  +mark-ids: `ids` read, and ids of items gone dropped from the set so it
::  stays as small as the store
++  mark-ids
  |=  [s=seen ids=(list @ta) live=(set @ta)]
  ^-  seen
  =/  all=(set @ta)  (~(gas in ids.s) ids)
  [%1 mark.s (~(int in all) live)]
::  +mark-all: everything up to `now` read
++  mark-all
  |=  now=@da
  ^-  seen
  [%1 now ~]
::  +held-sorted: held comet comments across pages, newest first
++  held-sorted
  |=  held=(list [pax=path id=@ta c=comment:lc])
  ^-  (list [pax=path id=@ta c=comment:lc])
  %+  sort  held
  |=  [a=[pax=path id=@ta c=comment:lc] b=[pax=path id=@ta c=comment:lc]]
  ?.  =(when.c.a when.c.b)  (gth when.c.a when.c.b)
  (aor id.a id.b)
::  +reply-targets: whom a new comment on `post` (under `parent`, if any)
::  by `src` is a reply to: the post's author and the parent comment's,
::  never the replier itself. Read from the board as it was before the
::  comment landed.
++  reply-targets
  |=  [brd=board:ft post=post-id:ft parent=(unit comment-id:ft) src=@p]
  ^-  (set @p)
  =/  p=(unit post:ft)  (~(get by posts.brd) post)
  ?~  p  ~
  =/  out=(set @p)  (sy ~[author.u.p])
  =?  out  ?=(^ parent)
    =/  c=(unit comment:ft)
      (~(get by (~(gut by comments.brd) post ~)) u.parent)
    ?~(c out (~(put in out) author.u.c))
  (~(del in out) src)
::  +post-title: a post's title, '' when it is gone
++  post-title
  |=  [brd=board:ft post=post-id:ft]
  ^-  @t
  =/  p=(unit post:ft)  (~(get by posts.brd) post)
  ?~(p '' title.u.p)
--
