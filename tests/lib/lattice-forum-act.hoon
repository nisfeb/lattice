::  Unit tests for /lib/lattice-forum-act: the pure state transition.
::
/+  *test, ft=lattice-forum-types, fb=lattice-forum-board, fa=lattice-forum-act
|%
++  brd
  ^-  board:ft
  [[%main 'Main' 'a board' ~zod ~2026.1.1 %reader |] (my ~[[~nec %poster] [~wet %mod]]) 1 ~ ~ ~ ~ '' ~]
++  now  ~2026.6.1
::  the board after, or a crash if refused
++  ok
  |=  [b=board:ft who=@p a=action:ft]
  ^-  board:ft
  =/  r  (act:fa b who now a)
  ?>  ?=(%& -.r)
  brd.p.r
::  did the action succeed
++  good
  |=(r=(each * *) ^-(? -.r))
++  test-new-post
  =/  r  (act:fa brd ~nec now [%new-post %main 'hi' ~ `'body'])
  ?>  ?=(%& -.r)
  ;:  weld
    (expect-eq !>(2) !>(next-post-id.brd.p.r))
    (expect-eq !>(`[1 ~nec 'hi' ~ `'body' now ~ ~ 0]) !>((~(get by posts.brd.p.r) 1)))
    ::  post 1 lands in bucket b0 of posts
    %+  expect-eq  !>(&)
    !>((lien puts.p.r |=(g=grub:fb =(pax.g /content/posts/b0))))
    ::  id 101 lands in bucket b1
    =/  b0=board:ft  brd
    =/  b2=board:ft  b0(next-post-id 101)
    =/  r2  (act:fa b2 ~nec now [%new-post %main 'hi' ~ ~])
    ?>  ?=(%& -.r2)
    %+  expect-eq  !>(&)
    !>((lien puts.p.r2 |=(g=grub:fb =(pax.g /content/posts/b1))))
  ==
++  test-refusals
  =/  b1=board:ft  (ok brd ~nec [%new-post %main 'hi' ~ ~])
  ;:  weld
    ::  a reader cannot post
    (expect-eq !>(|) !>((good (act:fa brd ~marzod now [%new-post %main 'hi' ~ ~]))))
    ::  non-author non-mod cannot delete
    (expect-eq !>(|) !>((good (act:fa b1 ~marzod now [%delete-post %main 1]))))
    ::  nor can a non-mod pin or set roles
    (expect-eq !>(|) !>((good (act:fa b1 ~nec now [%pin-post %main 1 &]))))
    (expect-eq !>(|) !>((good (act:fa b1 ~nec now [%set-role %main ~bus %mod]))))
    ::  author and mod can
    (expect-eq !>(&) !>((good (act:fa b1 ~nec now [%delete-post %main 1]))))
    (expect-eq !>(&) !>((good (act:fa b1 ~wet now [%delete-post %main 1]))))
    ::  gone: the post is out
    (expect-eq !>(|) !>((~(has by posts:(ok b1 ~wet [%delete-post %main 1])) 1)))
  ==
++  test-comment-tree
  =/  b1=board:ft  (ok brd ~nec [%new-post %main 'hi' ~ ~])
  =/  b2=board:ft  (ok b1 ~nec [%new-comment %main 1 ~ 'top'])
  =/  b3=board:ft  (ok b2 ~wet [%new-comment %main 1 `0 'reply'])
  =/  cs  (~(got by comments.b3) 1)
  ;:  weld
    (expect-eq !>(`[0 ~ ~nec 'top' now ~ ~]) !>((~(get by cs) 0)))
    (expect-eq !>(`[1 `0 ~wet 'reply' now ~ ~]) !>((~(get by cs) 1)))
    (expect-eq !>(2) !>(comment-count:(~(got by posts.b3) 1)))
    (expect-eq !>(2) !>((~(got by next-comment-ids.b3) 1)))
    ::  a reply to nothing is refused
    (expect-eq !>(|) !>((good (act:fa b2 ~nec now [%new-comment %main 1 `9 'x']))))
    ::  delete-comment: author-or-mod, and the count falls
    (expect-eq !>(|) !>((good (act:fa b3 ~bus now [%delete-comment %main 1 0]))))
    %+  expect-eq  !>(1)
    !>(comment-count:(~(got by posts:(ok b3 ~nec [%delete-comment %main 1 0])) 1))
  ==
++  test-votes
  =/  b1=board:ft  (ok brd ~nec [%new-post %main 'hi' ~ ~])
  =/  t=vote-target:ft  [%post 1]
  =/  u1=board:ft  (ok b1 ~bus [%upvote %main t])
  =/  u2=board:ft  (ok u1 ~bus [%upvote %main t])
  =/  d1=board:ft  (ok u2 ~bus [%downvote %main t])
  =/  r1=board:ft  (ok u2 ~bus [%remove-vote %main t])
  =/  c1=board:ft  (ok b1 ~nec [%new-comment %main 1 ~ 'c'])
  =/  cv=board:ft  (ok c1 ~bus [%upvote %main [%comment 1 0]])
  ;:  weld
    (expect-eq !>((sy ~[~bus])) !>(up-votes:(~(got by posts.u1) 1)))
    (expect-eq !>(u1) !>(u2))
    ::  a switch moves the vote
    (expect-eq !>(*(set @p)) !>(up-votes:(~(got by posts.d1) 1)))
    (expect-eq !>((sy ~[~bus])) !>(down-votes:(~(got by posts.d1) 1)))
    (expect-eq !>(b1) !>(r1))
    (expect-eq !>((sy ~[~bus])) !>(up-votes:(~(got by (~(got by comments.cv) 1)) 0)))
    ::  a vote on nothing changes nothing
    (expect-eq !>(b1) !>((ok b1 ~bus [%upvote %main [%post 9]])))
  ==
++  test-settings
  =/  b1=board:ft  (ok brd ~nec [%new-post %main 'hi' ~ ~])
  ;:  weld
    (expect-eq !>(&) !>(public.info:(ok brd ~zod [%set-public %main &])))
    (expect-eq !>(|) !>(public.info:(ok (ok brd ~zod [%set-public %main &]) ~zod [%set-public %main |])))
    (expect-eq !>('T') !>(title.info:(ok brd ~zod [%edit-board-info %main 'T' 'D'])))
    (expect-eq !>('D') !>(description.info:(ok brd ~zod [%edit-board-info %main 'T' 'D'])))
    (expect-eq !>(|) !>((good (act:fa brd ~zod now [%edit-board-info %main '' 'D']))))
    (expect-eq !>('side') !>(sidebar:(ok brd ~wet [%set-sidebar %main 'side'])))
    (expect-eq !>(%mod) !>((~(got by roles:(ok brd ~wet [%set-role %main ~bus %mod])) ~bus)))
    (expect-eq !>((sy ~[1])) !>(pinned:(ok b1 ~wet [%pin-post %main 1 &])))
    (expect-eq !>(*(set @ud)) !>(pinned:(ok (ok b1 ~wet [%pin-post %main 1 &]) ~wet [%pin-post %main 1 |])))
    (expect-eq !>(`[5 ~d1]) !>(prune:(ok brd ~zod [%set-prune %main `[5 ~d1]])))
  ==
--
