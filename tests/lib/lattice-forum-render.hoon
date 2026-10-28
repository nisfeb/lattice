::  Unit tests for /lib/lattice-forum-render: the ranked, paginated list,
::  the nested thread, and escaping of post bodies.
::
/+  *test, ft=lattice-forum-types, rn=lattice-forum-render
|%
++  now  ~2026.6.1
++  c
  ^-  ctx:rn
  [~zod & now "/b/main" "/theme.css"]
++  info
  ^-  board-info:ft
  [%main 'Main' 'a board' ~zod ~2026.1.1 %reader &]
++  mk-board
  |=  [posts=(list post:ft) cmts=(list comment:ft)]
  ^-  board:ft
  :*  info  ~  1
      (~(gas by *(map post-id:ft post:ft)) (turn posts |=(p=post:ft [id.p p])))
      ?~  cmts  ~
      %+  ~(put by *(map post-id:ft (map comment-id:ft comment:ft)))  1
      (~(gas by *(map comment-id:ft comment:ft)) (turn cmts |=(m=comment:ft [id.m m])))
      ~  ~  ''  ~
  ==
::  post-NNN, zero padded, so no title is a substring of another
::
++  title
  |=  id=@ud
  ^-  @t
  (crip "post-{(reap (sub 3 (lent (a-co:co id))) '0')}{(a-co:co id)}")
++  mk-post
  |=  [id=@ud ups=@ud body=(unit @t)]
  ^-  post:ft
  =/  voters=(set @p)  ?:(=(0 ups) ~ (silt (turn (gulf 1 ups) |=(i=@ud `@p`i))))
  [id ~zod (title id) ~ body (sub now (mul id ~m1)) voters ~ 0]
++  at
  |=  [ned=tape hay=tape]
  ^-  @ud
  (need (find ned hay))
++  has
  |=  [hay=tape ned=tape]
  ^-  ?
  ?=(^ (find ned hay))
++  to-html
  |=  m=manx
  ^-  tape
  (en-xml:html m)
::  101 posts: post 101 is hot, the rest are unvoted so the newest (lowest
::  id here) ranks first
::
++  big
  ^-  board:ft
  %+  mk-board
    [(mk-post 101 10 ~) (turn (gulf 1 100) |=(i=@ud (mk-post i 0 ~)))]
  ~
++  test-list-page-one
  =/  h=tape  (to-html (render-list:rn c big %hot 1))
  ;:  weld
    (expect-eq !>(&) !>((has h "post-101")))
    (expect-eq !>(&) !>((has h "post-029")))
    (expect-eq !>(|) !>((has h "post-030")))
    ::  the hot post ranks above the newest unvoted one
    (expect-eq !>(&) !>((lth (at "post-101" h) (at "post-001" h))))
    (expect-eq !>(&) !>((has h "page=2")))
    (expect-eq !>(|) !>((has h "page=0")))
    (expect-eq !>(&) !>((has h "page 1 of 4")))
  ==
++  test-list-page-two
  =/  h=tape  (to-html (render-list:rn c big %hot 2))
  ;:  weld
    (expect-eq !>(|) !>((has h "post-101")))
    (expect-eq !>(&) !>((has h "post-030")))
    (expect-eq !>(&) !>((has h "page=1")))
    (expect-eq !>(&) !>((has h "page=3")))
    ::  ranks continue across pages
    (expect-eq !>(&) !>((has h "31.")))
  ==
::  a long board still sorts in a blink: scored once per post
::
++  test-list-700
  =/  b=board:ft
    (mk-board (turn (gulf 1 700) |=(i=@ud (mk-post i (mod i 3) ~))) ~)
  =/  h=tape  (to-html (render-list:rn c b %hot 1))
  (expect-eq !>(&) !>((has h "page 1 of 24")))
++  test-thread-nests
  =/  p=post:ft  (mk-post 1 0 `'the body')
  =/  top=comment:ft  [1 ~ ~zod 'top-level' (sub now ~m5) ~ ~]
  =/  kid=comment:ft  [2 `1 ~zod 'child-reply' (sub now ~m4) ~ ~]
  =/  h=tape  (to-html (render-thread:rn c (mk-board ~[p] ~[top kid]) 1))
  ;:  weld
    (expect-eq !>(&) !>((has h "margin-left: 0px")))
    (expect-eq !>(&) !>((has h "margin-left: 20px")))
    (expect-eq !>(&) !>((has h "the body")))
    ::  child comes after its parent, and sits in the indented div
    (expect-eq !>(&) !>((lth (at "top-level" h) (at "child-reply" h))))
    (expect-eq !>(&) !>((lth (at "margin-left: 20px" h) (at "child-reply" h))))
    (expect-eq !>(&) !>((lth (at "top-level" h) (at "margin-left: 20px" h))))
  ==
++  test-escapes
  =/  p=post:ft  (mk-post 1 0 `'<script>alert(1)</script>')
  =/  evil=comment:ft  [1 ~ ~zod '<img onerror=x>' (sub now ~m5) ~ ~]
  =/  h=tape  (to-html (render-thread:rn c (mk-board ~[p] ~[evil]) 1))
  ;:  weld
    (expect-eq !>(|) !>((has h "<script>alert")))
    (expect-eq !>(&) !>((has h "&lt;script&gt;")))
    (expect-eq !>(|) !>((has h "<img onerror")))
  ==
++  test-theme-and-unsafe-url
  =/  p=post:ft  [1 ~zod 'x' `'javascript:alert(1)' ~ now ~ ~ 0]
  =/  h=tape  (to-html (render-list:rn c (mk-board ~[p] ~) %hot 1))
  =/  page=tape  (to-html (render-board:rn c (mk-board ~[p] ~) %hot 1))
  ;:  weld
    (expect-eq !>(|) !>((has h "href=\"javascript")))
    (expect-eq !>(&) !>((has page "/theme.css")))
  ==
++  test-submit-and-mod
  =/  s=tape  (to-html (render-submit:rn c %main))
  =/  m=tape  (to-html (render-mod:rn c (mk-board ~ ~)))
  ;:  weld
    (expect-eq !>(&) !>((has s "/b/main/submit")))
    (expect-eq !>(&) !>((has m "/b/main/mod/role")))
    (expect-eq !>(&) !>((has m "delete board")))
  ==
--
