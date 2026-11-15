::  Unit tests for /lib/lattice-forum-render: the ranked, paginated list,
::  the nested thread, escaping of post bodies, and thread tags.
::
/+  *test, ft=lattice-forum-types, rn=lattice-forum-render, fr=lattice-forum-rules
=*  fre  rn
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
      ~  ~  ''  ~  ~
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
++  vw
  |=  [m=sort-mode:rn pg=@ud ts=(list @tas)]
  ^-  view:rn
  [m pg (silt ts) '']
::  +count: how many times ned occurs in hay
::
++  count
  |=  [hay=tape ned=tape]
  ^-  @ud
  =/  i  (find ned hay)
  ?~  i  0
  +($(hay (slag +(u.i) hay)))
::  +hrefs: every href value on a page
::
++  hrefs
  |=  h=tape
  ^-  (list tape)
  =/  i  (find "href=\"" h)
  ?~  i  ~
  =/  rest=tape  (slag (add u.i 6) h)
  =/  e=@ud  (need (find "\"" rest))
  [(scag e rest) $(h (slag e rest))]
::  b: post 1 at ~2026.1.1 with a comment at ~2026.3.1, post 2 at
::  ~2026.2.1 with none. Tags: 1 -> bug idea, 2 -> bug, 9 (no such
::  post) -> ghost.
::
++  b
  ^-  board:ft
  =/  p1=post:ft  [1 ~zod (title 1) ~ ~ ~2026.1.1 ~ ~ 1]
  =/  p2=post:ft  [2 ~zod (title 2) ~ ~ ~2026.2.1 ~ ~ 0]
  =/  cm=comment:ft  [1 ~ ~zod 'late' ~2026.3.1 ~ ~]
  =/  brd=board:ft  (mk-board ~[p1 p2] ~[cm])
  brd(tags `(my ~[[1 (sy ~[%bug %idea])] [2 (sy ~[%bug])] [9 (sy ~[%ghost])]]))
::  b and post 3, which has no tags
::
++  b3
  ^-  board:ft
  =/  brd=board:ft  b
  brd(posts (~(put by posts.brd) 3 [3 ~zod (title 3) ~ ~ ~2026.2.2 ~ ~ 0]))
++  board-page
  |=  [cx=ctx:rn brd=board:ft v=view:rn]
  ^-  tape
  (to-html body:(render-board:rn cx brd v))
::  101 posts: post 101 is hot, the rest are unvoted so the newest (lowest
::  id here) ranks first
::
++  big
  ^-  board:ft
  %+  mk-board
    [(mk-post 101 10 ~) (turn (gulf 1 100) |=(i=@ud (mk-post i 0 ~)))]
  ~
++  test-list-page-one
  =/  h=tape  (to-html (render-list:rn c big (vw %hot 1 ~)))
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
  =/  h=tape  (to-html (render-list:rn c big (vw %hot 2 ~)))
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
  =/  h=tape  (to-html (render-list:rn c b (vw %hot 1 ~)))
  (expect-eq !>(&) !>((has h "page 1 of 24")))
++  test-thread-nests
  =/  p=post:ft  (mk-post 1 0 `'the body')
  =/  top=comment:ft  [1 ~ ~zod 'top-level' (sub now ~m5) ~ ~]
  =/  kid=comment:ft  [2 `1 ~zod 'child-reply' (sub now ~m4) ~ ~]
  =/  h=tape  (to-html body:(render-thread:rn c (mk-board ~[p] ~[top kid]) 1))
  ;:  weld
    (expect-eq !>(&) !>((has h "margin-left: 0px")))
    (expect-eq !>(&) !>((has h "margin-left: 20px")))
    (expect-eq !>(&) !>((has h "the body")))
    ::  child comes after its parent, and sits in the indented div
    (expect-eq !>(&) !>((lth (at "top-level" h) (at "child-reply" h))))
    (expect-eq !>(&) !>((lth (at "margin-left: 20px" h) (at "child-reply" h))))
    (expect-eq !>(&) !>((lth (at "top-level" h) (at "margin-left: 20px" h))))
  ==
::  a reply whose parent was deleted still shows, at the top level
++  test-thread-orphan-shows
  =/  p=post:ft  (mk-post 1 0 ~)
  =/  kid=comment:ft  [2 `1 ~zod 'orphan-reply' (sub now ~m4) ~ ~]
  =/  h=tape  (to-html body:(render-thread:rn c (mk-board ~[p] ~[kid]) 1))
  ;:  weld
    (expect-eq !>(&) !>((has h "orphan-reply")))
    (expect-eq !>(&) !>((has h "margin-left: 0px")))
  ==
::  replies made at the same instant read in the order they were made
++  test-thread-same-time-by-id
  =/  p=post:ft  (mk-post 1 0 ~)
  =/  t=@da  (sub now ~m4)
  =/  cs=(list comment:ft)
    (turn (gulf 1 9) |=(i=@ud `comment:ft`[i ~ ~zod (crip "reply-{(a-co:co i)}-x") t ~ ~]))
  =/  h=tape  (to-html body:(render-thread:rn c (mk-board ~[p] cs) 1))
  %+  expect-eq  !>(&)
  !>  %+  levy  (gulf 1 8)
  |=(i=@ud (lth (at "reply-{(a-co:co i)}-x" h) (at "reply-{(a-co:co +(i))}-x" h)))
++  test-escapes
  =/  p=post:ft  (mk-post 1 0 `'<script>alert(1)</script>')
  =/  evil=comment:ft  [1 ~ ~zod '<img onerror=x>' (sub now ~m5) ~ ~]
  =/  h=tape  (to-html body:(render-thread:rn c (mk-board ~[p] ~[evil]) 1))
  ;:  weld
    (expect-eq !>(|) !>((has h "<script>alert")))
    (expect-eq !>(&) !>((has h "&lt;script&gt;")))
    (expect-eq !>(|) !>((has h "<img onerror")))
  ==
::  the theme link is app.hoon's now (+forum-doc); a page answers its
::  title beside the body, for the head's <title>
::
++  test-title-and-unsafe-url
  =/  p=post:ft  [1 ~zod 'x' `'javascript:alert(1)' ~ now ~ ~ 0]
  =/  h=tape  (to-html (render-list:rn c (mk-board ~[p] ~) (vw %hot 1 ~)))
  =/  page  (render-board:rn c (mk-board ~[p] ~) (vw %hot 1 ~))
  ;:  weld
    (expect-eq !>(|) !>((has h "href=\"javascript")))
    (expect-eq !>('forum - Main') !>(title.page))
    (expect-eq !>(|) !>((has (to-html body.page) "href=\"javascript")))
  ==
++  test-submit-and-mod
  =/  s=tape  (to-html body:(render-submit:rn c (mk-board ~ ~)))
  =/  m=tape  (to-html body:(render-mod:rn c (mk-board ~ ~) &))
  =/  off=tape  (to-html body:(render-mod:rn c (mk-board ~ ~) |))
  ;:  weld
    (expect-eq !>(&) !>((has m "/b/main/mod/comets")))
    (expect-eq !>(&) !>((has m "turn comet posts off")))
    (expect-eq !>(&) !>((has off "turn comet posts on")))
    (expect-eq !>(&) !>((has s "/b/main/submit")))
    (expect-eq !>(&) !>((has m "/b/main/mod/role")))
    (expect-eq !>(&) !>((has m "delete board")))
  ==
::
::  tags
::
++  test-parse-view
  =/  v  (parse-view:fre (my ~[['sort' 'active'] ['tags' 'BUG,<b>,nosuch,,bug'] ['page' '2']]))
  ;:  weld
    (expect-eq !>(%active) !>(mode.v))
    (expect-eq !>(2) !>(page.v))
    (expect-eq !>((sy ~[%nosuch %bug])) !>(tags.v))
  ==
::  a filter keeps its first five valid distinct tags, in address order:
::  a thread holds five at most, so a longer filter could only be empty
::
++  test-parse-view-cap
  =/  ts=(list tape)  (turn (gulf 0 49) |=(i=@ud "t{(a-co:co i)}"))
  =/  arg=@t  (crip (zing (join "," `(list tape)`["a<b" "t0" ts])))
  =/  v  (parse-view:fre (my ~[['tags' arg]]))
  (expect-eq !>((sy ~[%t0 %t1 %t2 %t3 %t4])) !>(tags.v))
::  every character of a filter tag is checked, not only the first
::
++  test-parse-view-checks-tags
  =/  v  (parse-view:fre (my ~[['tags' 'a<b,ok,a&b,aB']]))
  (expect-eq !>((sy ~[%ok])) !>(tags.v))
++  test-parse-view-tq
  =/  v  (parse-view:fre (my ~[['tq' 'abcdefghijklmnopqrstuvwxyz0123']]))
  ;:  weld
    (expect-eq !>(%hot) !>(mode.v))
    (expect-eq !>(1) !>(page.v))
    (expect-eq !>('abcdefghijklmnopqrstuvwx') !>(tq.v))
    (expect-eq !>(`(set @tas)`~) !>(tags.v))
  ==
++  test-view-query
  ;:  weld
    (expect-eq !>("sort=active&tags=bug,idea") !>((view-query:fre %active (sy ~[%idea %bug]))))
    (expect-eq !>("sort=hot") !>((view-query:fre %hot ~)))
  ==
++  test-last-active
  =/  b=board:ft  b
  ;:  weld
    (expect-eq !>(~2026.3.1) !>((last-active:fre b (~(got by posts.b) 1))))
    (expect-eq !>(~2026.2.1) !>((last-active:fre b (~(got by posts.b) 2))))
    (expect-eq !>(~[1 2]) !>((turn (sort-by:fre %active now b ~(val by posts.b)) |=(p=post:ft id.p))))
  ==
++  test-tag-counts
  (expect-eq !>(~[[%bug 2] [%idea 1]]) !>((tag-counts:fre b)))
++  test-tags-of
  ;:  weld
    (expect-eq !>(~[%bug %idea]) !>((tags-of:fre b 1)))
    (expect-eq !>(`(list @tas)`~) !>((tags-of:fre b 3)))
  ==
::  a thread shows five tags at most, whatever its grub holds
::
++  test-tags-of-cap
  =/  brd=board:ft  b
  =/  many=(set @tas)  (silt (turn (gulf 1 1.000) |=(i=@ud `@tas`(crip "t{(a-co:co i)}"))))
  =.  tags.brd  `(my ~[[1 many]])
  (expect-eq !>(5) !>((lent (tags-of:fre brd 1))))
::  the datalist offers the 200 most used tags
::
++  test-datalist-cap
  =/  brd=board:ft  b
  =/  many=(list @tas)  (turn (gulf 1 250) |=(i=@ud `@tas`(crip "t{(a-co:co i)}")))
  =.  tags.brd  `(my ~[[1 (~(put in (silt many)) %zz)] [2 (sy ~[%zz])]])
  =/  h=tape  (to-html body:(render-submit:rn c brd))
  ;:  weld
    (expect-eq !>(200) !>((count h "<option")))
    (expect-eq !>(&) !>((has h "<option value=\"zz\"")))
  ==
++  test-filter-one-and-two
  =/  one=tape  (board-page c b3 (vw %hot 1 ~[%bug]))
  =/  two=tape  (board-page c b3 (vw %hot 1 ~[%bug %idea]))
  ;:  weld
    (expect-eq !>(&) !>((has one "post-002")))
    (expect-eq !>(&) !>((has one "post-001")))
    (expect-eq !>(|) !>((has one "post-003")))
    (expect-eq !>(&) !>((has two "post-001")))
    (expect-eq !>(|) !>((has two "post-002")))
    (expect-eq !>(|) !>((has two "post-003")))
  ==
::  the filter applies to pinned threads too
::
++  test-filter-pinned
  =/  brd=board:ft  b3
  =/  h=tape  (board-page c brd(pinned (sy ~[3])) (vw %hot 1 ~[%bug]))
  (expect-eq !>(|) !>((has h "post-003")))
++  test-filter-nosuch
  =/  h=tape  (board-page c b3 (vw %hot 1 ~[%nosuch]))
  ;:  weld
    (expect-eq !>(|) !>((has h "post-00")))
    (expect-eq !>(|) !>((has h "class=\"rw")))
    (expect-eq !>(&) !>((has h ">clear</a>")))
  ==
::  sort and page links keep the filter
::
++  test-filter-survives-links
  =/  brd=board:ft  big
  =.  tags.brd  `(~(run by posts.brd) |=(* (sy ~[%bug])))
  =/  h=tape  (board-page c brd (vw %hot 2 ~[%bug]))
  =/  hs=(list tape)  (hrefs h)
  =/  pages=(list tape)  (skim hs |=(t=tape (has t "page=")))
  =/  sorts=(list tape)
    (skim hs |=(t=tape |((has t "sort=new") (has t "sort=top") (has t "sort=active"))))
  ;:  weld
    (expect-eq !>(2) !>((lent pages)))
    (expect-eq !>(3) !>((lent sorts)))
    (expect-eq !>(&) !>((levy (weld pages sorts) |=(t=tape (has t "tags=bug")))))
  ==
++  test-row-tag-links
  =/  h=tape  (board-page c b3 (vw %hot 1 ~))
  =/  t=tape  (to-html body:(render-thread:rn c b 1))
  ;:  weld
    (expect-eq !>(&) !>((has h "href=\"/b/main?sort=hot&amp;tags=idea\"")))
    (expect-eq !>(&) !>((has t "href=\"/b/main?sort=hot&amp;tags=idea\"")))
  ==
++  test-filter-panel
  =/  off=tape  (board-page c b (vw %new 1 ~))
  =/  on=tape  (board-page c b (vw %new 1 ~[%bug]))
  =/  q=tape  (board-page c b [%new 1 ~ 'de'])
  ;:  weld
    (expect-eq !>(&) !>((has off ">Filter</summary>")))
    (expect-eq !>(|) !>((has off "open=")))
    (expect-eq !>(&) !>((has on "open=")))
    (expect-eq !>(&) !>((has q "open=")))
    ::  in the filter, bug's link removes it; idea's adds itself
    (expect-eq !>(&) !>((has on "href=\"/b/main?sort=new\"")))
    (expect-eq !>(&) !>((has on "href=\"/b/main?sort=new&amp;tags=bug,idea\"")))
    ::  with tq, only matching tags are listed
    (expect-eq !>(&) !>((has q ">idea (1)<")))
    (expect-eq !>(|) !>((has q ">bug (2)<")))
    (expect-eq !>(&) !>((has off ">bug (2)<")))
    (expect-eq !>(&) !>((has q "name=\"tq\"")))
  ==
::  query text never becomes markup
::
::  tq is free text, kept as typed, so it proves the page escapes it
::
++  test-query-escaped
  =/  plain=tape  (board-page c b (parse-view:fre ~))
  =/  v  (parse-view:fre (my ~[['tq' '"><b>']]))
  =/  evil=tape  (board-page c b v)
  ;:  weld
    (expect-eq !>('"><b>') !>(tq.v))
    (expect-eq !>(|) !>((has plain "<b>")))
    (expect-eq !>(|) !>((has evil "<b>")))
    (expect-eq !>(&) !>((has evil "value=\"&quot;&gt;&lt;b&gt;\"")))
  ==
++  test-submit-tags
  =/  brd=board:ft  b
  =/  old=tape  (to-html body:(render-submit:rn c brd(tags ~)))
  =/  new=tape  (to-html body:(render-submit:rn c brd(tags `~)))
  ;:  weld
    (expect-eq !>(|) !>((has old "name=\"t1\"")))
    (expect-eq !>(&) !>((has old "host does not take tags yet.")))
    (expect-eq !>(&) !>((has new "name=\"t1\"")))
    (expect-eq !>(&) !>((has new "name=\"t5\"")))
    (expect-eq !>(|) !>((has new "name=\"t6\"")))
    (expect-eq !>(&) !>((has new "<datalist")))
    (expect-eq !>(|) !>((has new "host does not take tags yet.")))
    (expect-eq !>(&) !>((has new pat-attrs)))
    (expect-eq !>(1) !>((count new hint)))
  ==
::  the t1 input as the browser validates it, as rendered
::
++  pat-attrs
  ^-  tape
  "pattern=\"[a-z][a-z0-9-]\{0,23}\" maxlength=\"24\" title=\"lowercase letters, digits and dashes, starting with a letter, 24 at most\" autocapitalize=\"none\" autocorrect=\"off\" spellcheck=\"false\""
++  hint
  ^-  tape
  "Tags: lowercase letters, digits and dashes, like bug-report. Up to five."
::  the pattern is meant to accept and refuse what valid-tag does
::
++  test-pattern-matches-valid-tag
  ;:  weld
    (expect-eq !>(&) !>((valid-tag:fr 'a')))
    (expect-eq !>(&) !>((valid-tag:fr 'bug-report')))
    (expect-eq !>(&) !>((valid-tag:fr 'abcdefghijklmnopqrstuvwx')))
    (expect-eq !>(|) !>((valid-tag:fr 'Bug')))
    (expect-eq !>(|) !>((valid-tag:fr 'a b')))
    (expect-eq !>(|) !>((valid-tag:fr '9x')))
    (expect-eq !>(|) !>((valid-tag:fr 'abcdefghijklmnopqrstuvwxy')))
  ==
::  a comet, or a viewer who may not act, sees no tag inputs
::
++  test-submit-no-tags-for-comet
  =/  comet=ctx:rn  [`@p`(bex 127) & now "/b/main" ""]
  =/  anon=ctx:rn  [~nec | now "/b/main" ""]
  ;:  weld
    (expect-eq !>(|) !>((has (to-html body:(render-submit:rn comet b)) "name=\"t1\"")))
    (expect-eq !>(|) !>((has (to-html body:(render-submit:rn anon b)) "name=\"t1\"")))
    (expect-eq !>(|) !>((has (to-html body:(render-thread:rn comet b 1)) "name=\"t1\"")))
  ==
++  test-edit-tags-form
  =/  brd=board:ft  b
  =/  p=post:ft  (~(got by posts.brd) 1)
  =.  posts.brd  (~(put by posts.brd) 1 p(author ~bus))
  =/  as
    |=  who=@p
    (to-html body:(render-thread:rn [who & now "/b/main" ""] brd 1))
  =/  author=tape  (as ~bus)
  ;:  weld
    (expect-eq !>(&) !>((has author "action=\"/b/main/1/tags\"")))
    ::  filled with the thread's tags, in aor order
    (expect-eq !>(&) !>((has author "name=\"t1\" list=\"tags\" {pat-attrs} value=\"bug\"")))
    (expect-eq !>(&) !>((has author "name=\"t2\" list=\"tags\" {pat-attrs} value=\"idea\"")))
    (expect-eq !>(1) !>((count author hint)))
    (expect-eq !>(&) !>((has (as ~zod) "action=\"/b/main/1/tags\"")))
    (expect-eq !>(|) !>((has (as ~nec) "action=\"/b/main/1/tags\"")))
    (expect-eq !>(|) !>((has (to-html body:(render-thread:rn c brd(tags ~) 1)) "/1/tags\"")))
  ==
++  test-no-script
  =/  pages=(list tape)
    :~  (board-page c b (vw %active 1 ~[%bug]))
        (board-page c b [%hot 1 ~ 'bu'])
        (to-html body:(render-thread:rn c b 1))
        (to-html body:(render-submit:rn c b))
    ==
  (expect-eq !>(|) !>((lien pages |=(t=tape (has t "<script")))))
--
