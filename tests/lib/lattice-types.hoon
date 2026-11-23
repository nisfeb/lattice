::  Unit tests for the frozen *-types libraries and their re-export by
::  each corresponding logic library, plus serialized ACL eval-action molds.
::
/+  *test, kt=lattice-know-types, lk=lattice-know, ct=lattice-comment-types, lc=lattice-comment, st=lattice-share-types, ls=lattice-share, skt=lattice-skills-types, lsk=lattice-skills, pt=lattice-pub-types, lp=lattice-pub, it=lattice-index-types, li=lattice-index, et=lattice-eval-types, le=lattice-eval
|%
++  test-know-types-reexport
  =/  e=know-entry:kt  ['hello' ~2026.1.1 (silt ~['a']) ~]
  =/  e2=know-entry:lk  e
  =/  ix=know-index:kt  (malt ~[[/a (to-index-entry:lk e2)]])
  =/  ix2=know-index:lk  ix
  =/  tc=term-cache:kt  (malt ~[[/a (row-of:lk /a e2)]])
  =/  tc2=term-cache:lk  tc
  =/  act=know-action:kt  [%save '/a' 'hello']
  =/  act2=know-action:lk  act
  ;:  weld
    (expect-eq !>(e) !>(e2))
    (expect-eq !>(ix) !>(ix2))
    (expect-eq !>(tc) !>(tc2))
    (expect-eq !>(act) !>(act2))
  ==
++  test-comment-types-reexport
  =/  c=comment:ct  [~zod ~2026.1.1 'hi']
  =/  c2=comment:lc  c
  =/  a=comment-action:ct  [/page/a 'hi']
  =/  a2=comment-action:lc  a
  ;:  weld
    (expect-eq !>(c) !>(c2))
    (expect-eq !>(a) !>(a2))
    (expect-eq !>(&) !>((act-ok:lc a2)))
  ==
++  test-share-types-reexport
  =/  e=entry:st  [~zod /apps/lattice/page/a/code 'read' ~2026.1.1]
  =/  sh=shared:ls  ~[e]
  =/  bn=banned:st  (silt ~[~nec])
  =/  bn2=banned:ls  bn
  =/  ac=action:st  [%add /apps/lattice/page/a/code 'read']
  =/  ac2=action:ls  ac
  =/  fa=fold-action:st  [%del ~zod /notes]
  =/  fa2=fold-action:ls  fa
  =/  ak=ask:st  [%ask /apps/lattice/page/a/code 'please']
  =/  ak2=ask:ls  ak
  ;:  weld
    (expect-eq !>(~[e]) !>(sh))
    (expect-eq !>(bn) !>(bn2))
    (expect-eq !>(ac) !>(ac2))
    (expect-eq !>(fa) !>(fa2))
    (expect-eq !>(ak) !>(ak2))
    (expect-eq !>(&) !>((is-banned:ls bn2 ~nec)))
  ==
++  test-skills-types-reexport
  =/  s=skill:skt  ['body' ~ ~2026.1.1 ~]
  =/  s2=skill:lsk  s
  =/  a=skill-action:skt  [%del 'demo']
  =/  a2=skill-action:lsk  a
  ;:  weld
    (expect-eq !>(s) !>(s2))
    (expect-eq !>(a) !>(a2))
  ==
++  test-pub-and-index-types-reexport
  =/  p=page:pt  'hello'
  =/  p2=page:lp  p
  =/  ix=pub-index:pt  (malt ~[[/pub/a/gmi (to-pub-row:lp p2 ~2026.1.1)]])
  =/  ix2=pub-index:lp  ix
  =/  fs=follows:pt  (silt ~[~zod])
  =/  fs2=follows:lp  fs
  =/  ps=page-sub:pt  [~zod /pub/a/gmi]
  =/  ps2=page-sub:lp  ps
  =/  bk=bucket:it  (malt ~[['hello' (malt ~[['/a' ['private' 1]]])]])
  =/  bk2=bucket:li  bk
  ;:  weld
    (expect-eq !>(p) !>(p2))
    (expect-eq !>(ix) !>(ix2))
    (expect-eq !>(fs) !>(fs2))
    (expect-eq !>(ps) !>(ps2))
    (expect-eq !>(bk) !>(bk2))
  ==
++  test-eval-types-and-acl-actions
  =/  cmd=eval-cmd:et  [1 'ping' 4]
  =/  cmd2=eval-cmd:le  cmd
  =/  sm=share-mode:et  %shared
  =/  sm2=share-mode:le  sm
  =/  acts=(list eval-action:le)
    :~  [%acl-ban %r1 ~nec]
        [%acl-unban %r2 ~nec]
        [%acl-forum-member %r3 %board ~nec &]
        [%acl-group-save %r4 'g' (silt ~[~nec]) ~[/apps/a] ~ &]
        [%acl-group-del %r5 'g']
        [%acl-share-page %r6 ~nec 'read' /notes]
        [%acl-share-folder %r7 'nec' (silt ~[~nec]) 'edit' /docs &]
        [%acl-unshare-file %r8 ~nec /notes]
        [%acl-move-grants /a `/b |]
    ==
  ;:  weld
    (expect-eq !>(cmd) !>(cmd2))
    (expect-eq !>(sm) !>(sm2))
    (expect-eq !>(9) !>((lent acts)))
  ==
--
