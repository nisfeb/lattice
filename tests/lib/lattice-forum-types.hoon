::  Unit tests for /lib/lattice-forum-types: the molds build and hold the
::  shapes the forum code will rely on.
::
/+  *test, ft=lattice-forum-types
|%
++  info
  ^-  board-info:ft
  [%main 'Main' 'a board' ~zod ~2026.1.1 %poster &]
++  test-board-mold
  =/  b=board:ft
    [info ~ 1 ~ ~ ~ ~ '' ~]
  ;:  weld
    (expect-eq !>(%main) !>(name.info.b))
    (expect-eq !>(`card:ft`[%1 info]) !>(`card:ft`[%1 info.b]))
    (expect-eq !>(`(unit prune-config:ft)`~) !>(prune.b))
  ==
++  test-post-comment-mold
  =/  p=post:ft
    [1 ~zod 'hi' `'https://x.y' ~ ~2026.1.1 ~ ~ 0]
  =/  c=comment:ft
    [1 ~ ~zod 'yo' ~2026.1.1 ~ ~]
  ;:  weld
    (expect-eq !>('hi') !>(title.p))
    (expect-eq !>(`(unit @t)``'https://x.y') !>(url.p))
    (expect-eq !>(`(unit comment-id:ft)`~) !>(parent.c))
  ==
++  test-action-mold
  =/  a=action:ft  [%upvote %main [%comment 1 2]]
  =/  d=action:ft  [%set-prune %main `[3 ~d7]]
  ;:  weld
    (expect-eq !>(%upvote) !>(-.a))
    (expect-eq !>(%set-prune) !>(-.d))
  ==
--
