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
::    %folder   a folder we follow on another ship has new pages
::              (+folder-item): one item per folder, filed again as the
::              count grows, `post` the count and `where` the folder
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
::  +source-cap: items kept from one source, so one ship cannot push
::  everyone else's out of the store
++  source-cap  ^-(@ud 50)
::  +source-of: whose item it is: the host that told us of a remote
::  reply, else the ship that did it
++  source-of
  |=  i=item
  ^-  @p
  ?:(?=(%remote kind.i) host.i who.i)
::  +overflow: the ids to cull, oldest first among them last: each past
::  +source-cap from its source, and each past +item-cap overall
++  overflow
  |=  items=(list [id=@ta i=item])
  ^-  (list @ta)
  =/  all  (newest-first items)
  =|  per=(map @p @ud)
  =|  kept=@ud
  =|  out=(list @ta)
  |-  ^-  (list @ta)
  ?~  all  (flop out)
  =/  s=@p  (source-of i.i.all)
  =/  n=@ud  (~(gut by per) s 0)
  ?:  |((gte n source-cap) (gte kept item-cap))
    $(all t.all, out [id.i.all out])
  $(all t.all, kept +(kept), per (~(put by per) s +(n)))
::
::  ==  note gate  ==
::
::  Any ship may poke a note (+reply-note, or a refusal) at our
::  /forum.sig. Each sender files at most +note-cap in a rolling
::  +note-window, as the comet gate counts comets. Past it, a note is
::  held back and counted, and one item per sender says how many
::  (+flood-item), so nothing is dropped unseen.
::
::  +$  note-hits: per sender, the stamps of the notes it filed (newest
::  first, at most +note-cap), and how many it sent past the cap since
+$  note-hits  (map @p [at=(list @da) over=@ud])
++  note-cap     ^-(@ud 30)
++  note-window  ^-(@dr ~h1)
::  +note-gate: may `who` file a note at `now`? ok, the count held back
::  (when not ok), and the new state, senders with nothing live dropped
++  note-gate
  |=  [hits=note-hits who=@p now=@da]
  ^-  [ok=? over=@ud hits=note-hits]
  =/  from=@da  ?:((lth now note-window) *@da (sub now note-window))
  =/  live  |=(at=(list @da) (skim at |=(t=@da (gth t from))))
  =/  cur=[at=(list @da) over=@ud]  (~(gut by hits) who [~ 0])
  =/  lv=(list @da)  (live at.cur)
  =/  kept=note-hits
    %-  ~(gas by *note-hits)
    %+  murn  ~(tap by (~(del by hits) who))
    |=  [s=@p r=[at=(list @da) over=@ud]]
    ^-  (unit [@p [at=(list @da) over=@ud]])
    =/  l=(list @da)  (live at.r)
    ?~(l ~ `[s l over.r])
  ?:  (lth (lent lv) note-cap)
    [& 0 (~(put by kept) who [(scag note-cap `(list @da)`[now lv]) 0])]
  =/  ov=@ud  +(over.cur)
  [| ov (~(put by kept) who [lv ov])]
::  +flood-title: the title of the item that counts a sender's held notes
++  flood-title  'more notes held back'
::  +flood-item: that item, about the last note `rn` held back from `host`
++  flood-item
  |=  [now=@da host=@p board=@tas post=@ud n=@ud]
  ^-  item
  %-  make
  :*  %remote  now  host  host  board  post  flood-title
      %+  rap  3
      :~  (crip ((d-co:co 1) n))
          ?:(=(1 n) ' note from ' ' notes from ')
          (scot %p host)
          ' held back: it sent more than '
          (crip ((d-co:co 1) note-cap))
          ' in an hour'
      ==
  ==
::  +flood-ids: the ids of the items counting `host`'s held notes
++  flood-ids
  |=  [items=(list [id=@ta i=item]) host=@p]
  ^-  (list @ta)
  %+  murn  items
  |=  [id=@ta i=item]
  ^-  (unit @ta)
  ?.  &(?=(%remote kind.i) =(host host.i) =(flood-title title.i))  ~
  `id
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
::  +folder-item: the one item a followed folder `rel` on `host` keeps,
::  `n` pages new in it. The writer culls the folder's older item
::  (+folder-ids) before it files this one, so a folder that gains pages
::  across reads is still one item, unread again with the new count.
++  folder-item
  |=  [now=@da host=@p rel=path n=@ud]
  ^-  item
  =/  where=@t  (spat rel)
  %-  make
  :*  %folder  now  host  host  where  n
      %+  rap  3
      :~  (crip ((d-co:co 1) n))
          ?:(=(1 n) ' new page in ' ' new pages in ')
          where  ' from '  (scot %p host)
      ==
      ''
  ==
::  +folder-ids: the ids of the %folder items about `rel` on `host`
++  folder-ids
  |=  [items=(list [id=@ta i=item]) host=@p rel=path]
  ^-  (list @ta)
  =/  where=@t  (spat rel)
  %+  murn  items
  |=  [id=@ta i=item]
  ^-  (unit @ta)
  ?.  &(?=(%folder kind.i) =(host host.i) =(where where.i))  ~
  `id
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
::  +move-items: the items about one of our own pages at or under `from`
::  (a page path as `where` holds it, a/b), changed to name the same page
::  under `to`, by id. A move takes a page's comments with it, and these
::  are what the inbox lists them by. Items about another ship's page or
::  a board stay as they are.
++  move-items
  |=  [items=(list [id=@ta i=item]) our=@p from=@t to=@t]
  ^-  (list [id=@ta i=item])
  =/  f=tape  (trip from)
  %+  murn  items
  |=  [id=@ta i=item]
  ^-  (unit [id=@ta i=item])
  ?.  &(?=(%comment kind.i) =(our host.i))  ~
  =/  w=tape  (trip where.i)
  ?:  =(w f)  `[id i(where to)]
  =/  pre=tape  (weld f "/")
  ?.  =(pre (scag (lent pre) w))  ~
  `[id i(where (crip (weld (trip to) (slag (lent f) w))))]
--
