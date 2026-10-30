::  lib/lattice-forum-act: the forum's pure state transition. +act applies
::  one action by one ship to a board and answers the board after it and
::  the grubs that must be put, or why it was refused. Ported from furum's
::  +act in furum-board.hoon, with no payment and no follow.
::
::  The caller holds what +act cannot: that board-level actions came from
::  our (%set-role, %set-public, %set-prune, %edit-board-info), the rate
::  limit (+rate-ok, +rate-update), %create-board and %delete-board (they
::  make and cull the whole directory), and the grubs to cull (+gone). The
::  role and size checks are here, as in furum, so a refusal reads the same
::  to the page.
::
/<  *   /lib/lattice-forum-types.hoon
/<  fb  /lib/lattice-forum-board.hoon
/<  fr  /lib/lattice-forum-rules.hoon
|%
::  +act: [board after, grubs to put] or a reason
::
++  act
  |=  [brd=board who=@p now=@da =action]
  ^-  (each [brd=board puts=(list grub:fb)] @t)
  =/  done
    |=  new=board
    ^-  (each [brd=board puts=(list grub:fb)] @t)
    &+[new (changed:fb brd new)]
  =/  mod=?  (is-mod:fr who brd)
  ?+    -.action  |+'not a board action'
      %edit-board-info
    ?:  =('' title.action)  |+'a board needs a title'
    %-  done
    %=  brd
      title.info        (crip (scag 200 (trip title.action)))
      description.info  (crip (scag 2.000 (trip description.action)))
    ==
  ::
      %set-public  (done brd(public.info public.action))
      %set-prune   (done brd(prune prune.action))
  ::
      %set-role
    ?.  mod  |+'only a moderator may set roles'
    (done brd(roles (~(put by roles.brd) who.action role.action)))
  ::
      %pin-post
    ?.  mod  |+'only a moderator may pin'
    %-  done
    %=  brd
      pinned  ?:  pinned.action
                (~(put in pinned.brd) id.action)
              (~(del in pinned.brd) id.action)
    ==
  ::
      %set-sidebar
    ?.  mod  |+'only a moderator may set the sidebar'
    ?:  (gth (met 3 sidebar.action) 10.000)
      |+'the sidebar holds at most 10,000 bytes'
    (done brd(sidebar sidebar.action))
  ::
      %new-post
    ?.  (can-post:fr who brd)  |+'your role on this board cannot post'
    ?.  (sane-post:fr title.action url.action body.action)
      |+'a post needs a title (300 bytes at most), a url of 2,048 and a body of 40,000'
    =/  id=post-id  next-post-id.brd
    %-  done
    %=  brd
      next-post-id  +(id)
      posts  (~(put by posts.brd) id [id who title.action url.action body.action now ~ ~ 0])
    ==
  ::
      %delete-post
    ?~  p=(~(get by posts.brd) id.action)  |+'post not found'
    ?.  (can-delete:fr who author.u.p brd)
      |+'only its author or a moderator may delete a post'
    =/  new=board  (drop-posts brd ~[id.action])
    &+[new (changed:fb brd new)]
  ::
      %edit-post
    ?~  p=(~(get by posts.brd) id.action)  |+'post not found'
    ?.  =(who author.u.p)  |+'only the author can edit this post'
    ?.  (sane-post:fr title.action ~ body.action)
      |+'a post needs a title (300 bytes at most) and a body of 40,000'
    (done brd(posts (~(put by posts.brd) id.action u.p(title title.action, body body.action))))
  ::
      %new-comment
    ?.  (can-post:fr who brd)  |+'your role on this board cannot comment'
    ?.  (sane-comment:fr body.action)  |+'a comment holds 1 to 10,000 bytes'
    ?~  p=(~(get by posts.brd) post.action)  |+'post not found'
    =/  pc=(map comment-id comment)  (~(gut by comments.brd) post.action ~)
    ?:  ?&(?=(^ parent.action) !(~(has by pc) u.parent.action))
      |+'no such comment to reply to'
    =/  cid=comment-id  (~(gut by next-comment-ids.brd) post.action 0)
    %-  done
    %=  brd
      comments          (~(put by comments.brd) post.action (~(put by pc) cid [cid parent.action who body.action now ~ ~]))
      next-comment-ids  (~(put by next-comment-ids.brd) post.action +(cid))
      posts             (~(put by posts.brd) post.action u.p(comment-count +(comment-count.u.p)))
    ==
  ::
      %delete-comment
    =/  pc=(map comment-id comment)  (~(gut by comments.brd) post.action ~)
    ?~  c=(~(get by pc) id.action)  (done brd)
    ?.  (can-delete:fr who author.u.c brd)
      |+'only its author or a moderator may delete a comment'
    =.  comments.brd  (~(put by comments.brd) post.action (~(del by pc) id.action))
    ?~  p=(~(get by posts.brd) post.action)  (done brd)
    (done brd(posts (~(put by posts.brd) post.action u.p(comment-count (dec (max 1 comment-count.u.p))))))
  ::
      %upvote       (done (vote brd target.action who %up))
      %downvote     (done (vote brd target.action who %down))
      %remove-vote  (done (vote brd target.action who %remove))
  ==
::  +drop-posts: posts gone, with their threads
::
++  drop-posts
  |=  [brd=board ids=(list post-id)]
  ^-  board
  %+  roll  ids
  |=  [id=post-id b=_brd]
  %=  b
    posts             (~(del by posts.b) id)
    comments          (~(del by comments.b) id)
    next-comment-ids  (~(del by next-comment-ids.b) id)
  ==
::  +vote: one ship's vote on a post or comment; a vote on nothing is
::  nothing
::
++  vote
  |=  [brd=board target=vote-target who=@p dir=?(%up %down %remove)]
  ^-  board
  =/  cast
    |=  [up=(set @p) dn=(set @p)]
    ^-  [(set @p) (set @p)]
    :-  ?:(=(%up dir) (~(put in up) who) (~(del in up) who))
    ?:(=(%down dir) (~(put in dn) who) (~(del in dn) who))
  ?-    -.target
      %post
    ?~  p=(~(get by posts.brd) id.target)  brd
    =/  [up=(set @p) dn=(set @p)]  (cast up-votes.u.p down-votes.u.p)
    brd(posts (~(put by posts.brd) id.target u.p(up-votes up, down-votes dn)))
  ::
      %comment
    ?~  pc=(~(get by comments.brd) post.target)  brd
    ?~  c=(~(get by u.pc) id.target)  brd
    =/  [up=(set @p) dn=(set @p)]  (cast up-votes.u.c down-votes.u.c)
    =/  new=(map comment-id comment)  (~(put by u.pc) id.target u.c(up-votes up, down-votes dn))
    brd(comments (~(put by comments.brd) post.target new))
  ==
--
