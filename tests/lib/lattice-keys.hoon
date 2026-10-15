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
  =/  rw  (row [%write [%all %read] [%off ~] | ~])
  =/  ro  (row [%read [%all %none] [%all ~] | ~])
  ;:  weld
    (expect-eq !>(&) !>((may rw 'POST' /know-save)))
    (expect-eq !>(&) !>((may rw 'POST' /know-save-batch)))
    (expect-eq !>(&) !>((may rw 'GET' /page-source)))
    (expect-eq !>(|) !>((may rw 'POST' /page-save)))
    (expect-eq !>(|) !>((may rw 'GET' /fetch)))
    (expect-eq !>(&) !>((may ro 'GET' /know-recall)))
    (expect-eq !>(|) !>((may ro 'POST' /know-save)))
    (expect-eq !>(|) !>((may ro 'POST' /know-save-batch)))
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
    (expect-eq !>(`(each [@t @t scope] @t)`&+['laptop' 'claude-laptop' [%write [%all %none] [%all ~] | ~]]) !>(ok))
    (expect-eq !>(`(each [@t @t scope] @t)`&+['l' 'b' [%read [%all %none] [%off ~] & ~]]) !>(sen))
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
++  test-upgrade-keys
  =/  old=(map @t key-row-0)
    (my ~[['abc' ['abc' 'n' 'b' [%write %read &] 's' 'h' ~2026.1.1 `~2026.1.2]]])
  =/  new=keys  (upgrade-keys old)
  =/  k=key-row  (~(got by new) 'abc')
  ;:  weld
    (expect-eq !>(`(unit @da)`~) !>(taint.k))
    (expect-eq !>(`(unit @da)``~2026.1.2) !>(used.k))
    ::  the row's scope is [%write %read &]; upgrade-keys injects sensitive=|
    ::  giving upgrade [%write %read & |]: memory=%write pages=[%all %read]
    ::  web=[%all ~] sensitive=| origin=~
    (expect-eq !>(`scope`[%write [%all %read] [%all ~] | ~]) !>(scope.k))
    (expect-eq !>(new) !>((upgrade-keys new)))
    (expect-eq !>(`keys`~) !>((upgrade-keys 42)))
  ==
++  test-upgrade-old-flat-scope  ^-  tang
  :: old row scope was [memory=level pages=level web=? sensitive=?]
  =/  old=*  [%read %write & |]
  =/  new  (upgrade old)
  ;:  weld
    (expect-eq !>(pages.new) !>(`pages-scope`[%all %write]))
    (expect-eq !>(web.new) !>(`web-scope`[%all ~]))
    (expect-eq !>(sensitive.new) !>(|))
    (expect-eq !>(origin.new) !>(`(unit @p)`~))
  ==
++  test-upgrade-web-off  ^-  tang
  =/  new  (upgrade [%none %none | |])
  (expect-eq !>(web.new) !>(`web-scope`[%off ~]))
++  test-tainted
  =/  k  (row *scope)
  ;:  weld
    (expect-eq !>(|) !>((tainted k ~2026.1.1)))
    (expect-eq !>(&) !>((tainted k(taint `~2026.1.1) ~2026.1.1..11.59.59)))
    (expect-eq !>(|) !>((tainted k(taint `~2026.1.1) ~2026.1.1..12.00.00)))
  ==
::  a key saves only kinds that render escaped
++  test-page-type-ok
  ;:  weld
    (expect-eq !>(&) !>((page-type-ok 'md')))
    (expect-eq !>(&) !>((page-type-ok 'gmi')))
    (expect-eq !>(&) !>((page-type-ok 'text')))
    (expect-eq !>(&) !>((page-type-ok 'tex')))
    (expect-eq !>(&) !>((page-type-ok 'css')))
    (expect-eq !>(&) !>((page-type-ok 'index')))
    (expect-eq !>(|) !>((page-type-ok 'hoon')))
    (expect-eq !>(|) !>((page-type-ok 'html')))
    (expect-eq !>(|) !>((page-type-ok 'js')))
    (expect-eq !>(|) !>((page-type-ok '')))
    (expect-eq !>(|) !>((page-type-ok 'MD')))
  ==
::  mk-key: build a key-row with given pages/web/sensitive/origin
++  mk-key
  |=  [pgs=pages-scope wsc=web-scope sen=? org=(unit @p)]
  ^-  key-row
  :*  'mk'  'mk-key'  'test'
      [%write pgs wsc sen org]
      'salt'  (hash-token 'salt' 'sekrit')
      ~2026.1.1  ~  ~
  ==
::  under: segment-prefix test (grant is a prefix of target at segment boundary)
++  test-under-boundary  ^-  tang
  ;:  weld
    (expect !>((under /a/b /a/b)))          :: exact match
    (expect !>((under /a/b /a/b/c)))        :: subtree
    (expect !>(!(under /a/b /a/bc)))        :: NOT a sibling with shared string prefix
    (expect !>(!(under /a/b /a)))           :: parent is not under child
  ==
::  may-path %some: read-set and write-set are independent
++  test-may-path-some-write  ^-  tang
  =/  k=key-row
    (mk-key [%some [(sy ~[/notes]) (sy ~[/notes/out])]] [%off ~] | ~)
  ;:  weld
    (expect !>((may-path k %local /notes/out/x %write)))
    (expect !>(!(may-path k %local /notes/other %write)))  :: not in write-set
    (expect !>((may-path k %local /notes/other %read)))    :: in read-set
    (expect !>(!(may-path k %local /elsewhere %read)))     :: ungranted
  ==
::  may-path %all: level-ok decides; %some: path membership decides
++  test-may-path-all-vs-some  ^-  tang
  =/  k-all=key-row
    (mk-key [%all %write] [%off ~] | ~)
  =/  k-none=key-row
    (mk-key [%all %none] [%off ~] | ~)
  =/  k-some=key-row
    (mk-key [%some [(sy ~[/a]) ~]] [%off ~] | ~)
  ;:  weld
    (expect !>((may-path k-all %local /any/path %read)))
    (expect !>((may-path k-all %local /any/path %write)))
    (expect !>(!(may-path k-none %local /any/path %read)))
    (expect !>(!(may-path k-none %local /any/path %write)))
    (expect !>((may-path k-some %local /a/child %read)))
    (expect !>(!(may-path k-some %local /b %read)))
  ==
::  may-path %ship: off=deny, all=read-only, some=consult per-ship path-sets
++  test-may-path-web  ^-  tang
  =/  k-off=key-row   (mk-key [%all %write] [%off ~] | ~)
  =/  k-web-all=key-row  (mk-key [%all %write] [%all ~] | ~)
  =/  p=@p  ~zod
  =/  k-web-some=key-row
    (mk-key [%all %write] [%some (~(put by *(map @p paths)) p [(sy ~[/pub]) ~])] | ~)
  ;:  weld
    (expect !>(!(may-path k-off [%ship ~zod] /any %read)))
    ::  broad %all web is read-only across ships
    (expect !>((may-path k-web-all [%ship ~zod] /any %read)))
    (expect !>(!(may-path k-web-all [%ship ~zod] /any %write)))
    ::  %some: per-ship read-set only
    (expect !>((may-path k-web-some [%ship ~zod] /pub/page %read)))
    (expect !>(!(may-path k-web-some [%ship ~zod] /other %read)))
    ::  unknown ship denied
    (expect !>(!(may-path k-web-some [%ship ~wes] /pub/page %read)))
  ==
--
