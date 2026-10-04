::  Unit tests for /lib/lattice-keys (agent keys).  Run with:
::    -test %/tests/lib/lattice-keys ~
::
/+  *test, *lattice-keys
|%
++  row
  |=  s=scope
  ^-  key-row
  ['abc123' 'laptop' 'claude-laptop' s 'salt' (hash-token 'salt' 'sekrit') ~2026.1.1 ~ ~]
++  test-parse-bearer
  ;:  weld
    (expect-eq !>(`(unit [@t @t])``['abc' 'x.y']) !>((parse-bearer 'Bearer abc.x.y')))
    (expect-eq !>(`(unit [@t @t])``['abc' 'xy']) !>((parse-bearer 'bearer   abc.xy')))
    (expect-eq !>(`(unit [@t @t])`~) !>((parse-bearer 'Basic abc.xy')))
    (expect-eq !>(`(unit [@t @t])`~) !>((parse-bearer 'Bearer abcxy')))
    (expect-eq !>(`(unit [@t @t])`~) !>((parse-bearer 'Bearer .xy')))
    (expect-eq !>(`(unit [@t @t])`~) !>((parse-bearer 'Bearer abc.')))
  ==
++  test-key-ok
  ;:  weld
    (expect-eq !>(&) !>((key-ok (row *scope) 'sekrit')))
    (expect-eq !>(|) !>((key-ok (row *scope) 'sekriT')))
  ==
::  a key reaches only the one-segment routes its scope names
++  test-may
  =/  rw  (row [%write %read | |])
  =/  ro  (row [%read %none & |])
  ;:  weld
    (expect-eq !>(&) !>((may rw 'POST' /know-save)))
    (expect-eq !>(&) !>((may rw 'GET' /page-source)))
    (expect-eq !>(|) !>((may rw 'POST' /page-save)))
    (expect-eq !>(|) !>((may rw 'GET' /fetch)))
    (expect-eq !>(&) !>((may ro 'GET' /know-recall)))
    (expect-eq !>(|) !>((may ro 'POST' /know-save)))
    (expect-eq !>(|) !>((may ro 'GET' /page-search)))
    (expect-eq !>(&) !>((may ro 'GET' /fetch)))
    ::  never: owner routes, other methods, deeper paths
    (expect-eq !>(|) !>((may rw 'POST' /key-mint)))
    (expect-eq !>(|) !>((may rw 'POST' /page-share)))
    (expect-eq !>(|) !>((may rw 'POST' /know-publish)))
    (expect-eq !>(|) !>((may rw 'GET' /know-save)))
    (expect-eq !>(|) !>((may rw 'GET' /x/know-search)))
    (expect-eq !>(|) !>((may rw 'GET' /)))
  ==
++  test-de-mint
  =/  ok  (de-mint (need (de:json:html '{"name":"laptop","by":"claude-laptop","scope":{"memory":"write","web":true}}')))
  =/  sen  (de-mint (need (de:json:html '{"name":"l","by":"b","scope":{"memory":"read","sensitive":true}}')))
  ;:  weld
    (expect-eq !>(`(each [@t @t scope] @t)`&+['laptop' 'claude-laptop' [%write %none & |]]) !>(ok))
    (expect-eq !>(`(each [@t @t scope] @t)`&+['l' 'b' [%read %none | &]]) !>(sen))
    ::  by is one line of front matter: no newline, no colon
    (expect-eq !>(%|) !>(-:(de-mint (need (de:json:html '{"name":"a","by":"x\\nsuperseded-by: /y"}')))))
    (expect-eq !>(%|) !>(-:(de-mint (need (de:json:html '{"name":"a","by":""}')))))
    (expect-eq !>(%|) !>(-:(de-mint (need (de:json:html '{"by":"x"}')))))
  ==
++  test-touch-due
  ;:  weld
    (expect-eq !>(&) !>((touch-due ~ ~2026.1.1)))
    (expect-eq !>(|) !>((touch-due `~2026.1.1 ~2026.1.1..00.59.59)))
    (expect-eq !>(&) !>((touch-due `~2026.1.1 ~2026.1.1..01.00.00)))
  ==
::  keys stored before clearance existed read back, uncleared and untainted
++  test-upgrade
  =/  old=(map @t key-row-0)
    (my ~[['abc' ['abc' 'n' 'b' [%write %read &] 's' 'h' ~2026.1.1 `~2026.1.2]]])
  =/  new=keys  (upgrade old)
  =/  k=key-row  (~(got by new) 'abc')
  ;:  weld
    (expect-eq !>(`scope`[%write %read & |]) !>(scope.k))
    (expect-eq !>(`(unit @da)`~) !>(taint.k))
    (expect-eq !>(`(unit @da)``~2026.1.2) !>(used.k))
    (expect-eq !>(new) !>((upgrade new)))
    (expect-eq !>(`keys`~) !>((upgrade 42)))
  ==
++  test-tainted
  =/  k  (row *scope)
  ;:  weld
    (expect-eq !>(|) !>((tainted k ~2026.1.1)))
    (expect-eq !>(&) !>((tainted k(taint `~2026.1.1) ~2026.1.1..11.59.59)))
    (expect-eq !>(|) !>((tainted k(taint `~2026.1.1) ~2026.1.1..12.00.00)))
  ==
--
