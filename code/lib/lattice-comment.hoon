::  /lib/lattice-comment, molds for page comments (Urbit-ships-only).
::
::  A comment is a small grub under /comments/<page>/<id>, authored by the POKING
::  ship (taken from the poke SOURCE via get-poke-src, so it is cryptographic,
::  never self-reported, and can't be spoofed). Page content under /page/ stays
::  owner-only. The public comments fiber's poke weir is the only door open to
::  other ships, and it reaches only /comments/. So a commenter can append a
::  comment but structurally cannot edit a page.
::
|%
::  +$  comment: one stored comment grub.
::
+$  comment  [author=@p when=@da body=@t]
::  +$  comment-action: the poke payload a commenter sends. `author` is NOT
::  carried here. The receiver takes it from the poke source. body is length-
::  capped and HTML-escaped by the receiver/renderer.
::
+$  comment-action  [page=path body=@t]
::  +max-body: comment length cap (bytes). Bounds storage + render of a hostile
::  commenter, like the peer-page data cap.
::
++  max-body  ^-(@ud 4.096)
::  +per-author: of a page's 200 slots, how many one author may hold, its
::  moons counted with it and each comet on its own
::  (+quota-family:lattice-share).
::  The owner is exempt. One pool for everyone let a single sender fill a
::  page and lock everyone else out (security audit run-1).
++  per-author  ^-(@ud 20)
::
::  ==  public thread  ==
::
::  A published page that takes comments shows its accepted comments to
::  everyone, at [/pub/thread/<page> %list] (+thread-cord), with
::  [/pub %threads] naming the pages that have one. Accepted is what is
::  filed under /comments/<page>: every planet's and moon's comment, and a
::  comet's that was open or held and then approved. A held comment waits
::  under /comments-held and a rejected one is gone, so neither is ever
::  passed here. A page whose comments are off shows none, and its filed
::  comments come back when they are turned on again.
::
::  +thread-cap: how many of a page's newest comments are published. The
::  store holds 200 a page, and approvals may pass that.
++  thread-cap  ^-(@ud 400)
::  +public-thread: the comments a page shows, oldest first, ties broken by
::  author so the order is the same on every build
++  public-thread
  |=  [on=? filed=(list [id=@ta c=comment])]
  ^-  (list [id=@ta c=comment])
  ?.  on  ~
  =/  srt=(list [id=@ta c=comment])
    %+  sort  filed
    |=  [a=[id=@ta c=comment] b=[id=@ta c=comment]]
    ?.  =(when.c.a when.c.b)  (lth when.c.a when.c.b)
    (aor id.a id.b)
  =/  n=@ud  (lent srt)
  ?:((gth n thread-cap) (slag (sub n thread-cap) srt) srt)
::  +unix-ms: a date as unix milliseconds
++  unix-ms
  |=  d=@da
  ^-  @ud
  ?:  (lth d ~1970.1.1)  0
  (div (mul (sub d ~1970.1.1) 1.000) ~s1)
::  +thread-cord: a public thread as json text, under the plain %noun mark
::  so a reader without lattice's marks (the desktop's comet) reads it.
::  {"v":1,"comments":[{"id","author","when" (unix ms),"body"}]}. Bodies
::  are raw: every reader escapes them, as the owner's view does.
++  thread-cord
  |=  cs=(list [id=@ta c=comment])
  ^-  @t
  %-  en:json:html
  %-  pairs:enjs:format
  :~  ['v' (numb:enjs:format 1)]
      :-  'comments'
      :-  %a
      %+  turn  cs
      |=  [id=@ta c=comment]
      %-  pairs:enjs:format
      :~  ['id' s+id]
          ['author' s+(scot %p author.c)]
          ['when' (numb:enjs:format (unix-ms when.c))]
          ['body' s+body.c]
      ==
  ==
::  +thread-rows: a publisher's thread cord read back. A peer's text, so
::  anything that will not read is dropped: a bad row alone, or the whole
::  list when it is not one. `when` comes back as a date.
++  thread-rows
  |=  t=@t
  ^-  (list [id=@ta c=comment])
  ?.  (lte (met 3 t) 1.000.000)  ~
  =/  j=(unit json)  (de:json:html t)
  ?.  ?=([~ %o *] j)  ~
  =/  cs=(unit json)  (~(get by p.u.j) 'comments')
  ?.  ?=([~ %a *] cs)  ~
  %+  murn  p.u.cs
  |=  r=json
  ^-  (unit [id=@ta c=comment])
  ?.  ?=([%o *] r)  ~
  =/  id=(unit json)  (~(get by p.r) 'id')
  =/  au=(unit json)  (~(get by p.r) 'author')
  =/  wh=(unit json)  (~(get by p.r) 'when')
  =/  bo=(unit json)  (~(get by p.r) 'body')
  ?.  &(?=([~ %s *] au) ?=([~ %n *] wh) ?=([~ %s *] bo))  ~
  =/  who=(unit @p)  (slaw %p p.u.au)
  =/  ms=(unit @ud)  (rush p.u.wh dem)
  ?:  |(?=(~ who) ?=(~ ms))  ~
  =/  nid=@ta
    ?.  ?=([~ %s *] id)  ''
    ?.(((sane %ta) p.u.id) '' p.u.id)
  =/  when=@da  (add ~1970.1.1 (div (mul u.ms ~s1) 1.000))
  `[nid [u.who when (end [3 max-body] p.u.bo)]]
::  +thread-names / +threads-cord: [/pub %threads], one page name a line,
::  named as /pub/comments names them
++  thread-names
  |=  t=@t
  ^-  (set @t)
  (silt (skip (to-wain:format t) |=(l=@t =('' l))))
++  threads-cord
  |=  s=(set @t)
  ^-  @t
  =/  l=(list @t)  (sort ~(tap in s) aor)
  ?~(l '' (of-wain:format l))
--
