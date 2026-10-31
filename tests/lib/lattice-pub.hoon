::  Unit tests for /lib/lattice-pub (pure public-page helpers).  Run with:
::    -test %/tests/lib/lattice-pub ~   (or the run-tests MCP tool)
::
::  Faced import (lp=lattice-pub) rather than wildcard, so `page` and friends
::  can't clash with anything already in the subject.
::
/+  *test, lp=lattice-pub
|%
++  base  `path`/lattice/pub/vault
::  +strip-pub: drops a leading `pub` and leaves a pub-less key untouched.
::
++  test-strip-pub
  ;:  weld
    (expect-eq !>(`path`/a/gmi) !>((strip-pub:lp /pub/a/gmi)))
    (expect-eq !>(`path`/a/gmi) !>((strip-pub:lp /a/gmi)))
    (expect-eq !>(`path`~) !>((strip-pub:lp ~)))
  ==
::  +key-to-rail: a content-map key -> [base+dir leaf]. The leading `pub` is
::  stripped and the key's own tail becomes the grub leaf, so /pub/a/gmi and
::  /pub/a/b/gmi coexist (dir /a holds file `gmi` AND child dir `b`).
::
++  test-key-to-rail
  ;:  weld
    (expect-eq !>(`(unit vrail:lp)`[~ /lattice/pub/vault/a %gmi]) !>((key-to-rail:lp base /pub/a/gmi)))
    (expect-eq !>(`(unit vrail:lp)`[~ /lattice/pub/vault/a/b %gmi]) !>((key-to-rail:lp base /pub/a/b/gmi)))
    ::  the home page /pub/index/gmi sits under vault/index, NOT colliding with
    ::  the sibling /pub/index grub (which lives outside the vault subtree).
    (expect-eq !>(`(unit vrail:lp)`[~ /lattice/pub/vault/index %gmi]) !>((key-to-rail:lp base /pub/index/gmi)))
    ::  empty / degenerate key has no leaf to name
    (expect-eq !>(`(unit vrail:lp)`~) !>((key-to-rail:lp base ~)))
    ::  a pub-less key is REJECTED (~), not aliased onto /pub/a/gmi's grub. The
    ::  map must be injective or two index rows share one body.
    (expect-eq !>(`(unit vrail:lp)`~) !>((key-to-rail:lp base /a/gmi)))
    ::  a non-gmi leaf is REJECTED (~). The reader only ever reads .../gmi, so such a
    ::  grub would be unreadable and its index row divergent.
    (expect-eq !>(`(unit vrail:lp)`~) !>((key-to-rail:lp base /pub/notes/intro)))
    ::  an empty spur (/pub/gmi, from an empty publish path) is REJECTED (~). It
    ::  collapses onto the vault root and the reader maps it back to /index.
    (expect-eq !>(`(unit vrail:lp)`~) !>((key-to-rail:lp base /pub/gmi)))
  ==
::  +to-pub-row: project a page body onto its index row (now, bytes, sham).
::
++  test-to-pub-row
  ;:  weld
    (expect-eq !>(`pub-row:lp`[~2026.1.1 2 (sham 'hi')]) !>((to-pub-row:lp 'hi' ~2026.1.1)))
    (expect-eq !>(`pub-row:lp`[~2026.2.2 5 (sham 'hello')]) !>((to-pub-row:lp 'hello' ~2026.2.2)))
  ==
::  a page's name in the revision list: the vault key without /pub and /gmi
++  test-page-name
  ;:  weld
    (expect-eq !>('/site/talon/index') !>((page-name:lp /pub/site/talon/index/gmi)))
    (expect-eq !>('/index') !>((page-name:lp /pub/index/gmi)))
  ==
::  a revision's id depends on the salt, the name and the revision, and
::  only on them
++  test-page-id
  ;:  weld
    (expect-eq !>((page-id:lp 1 '/a' 3)) !>((page-id:lp 1 '/a' 3)))
    (expect-eq !>(%.n) !>(=((page-id:lp 1 '/a' 3) (page-id:lp 2 '/a' 3))))
    (expect-eq !>(%.n) !>(=((page-id:lp 1 '/a' 3) (page-id:lp 1 '/b' 3))))
    (expect-eq !>(%.n) !>(=((page-id:lp 1 '/a' 3) (page-id:lp 1 '/a' 4))))
    (expect-eq !>(%.y) !>((lte (met 3 (page-id:lp 1 '/a' 3)) 16)))
  ==
::  a rotation's culls name each row's revision under the OLD salt, never
::  the new one the regrow just bound, and skip a name that is no path
++  test-salt-spurs
  =/  revs=(map @t [rev=@ud id=@uv])
    (malt ~[['/a' 3 (page-id:lp 2 '/a' 3)] ['/b/c' 12 0v0] ['nope' 1 0v0]])
  =/  got=(set path)  (silt (salt-spurs:lp 1 revs))
  =/  a1=path  `path`/pub/page/a/(scot %uv (page-id:lp 1 '/a' 3))
  =/  a2=path  `path`/pub/page/a/(scot %uv (page-id:lp 2 '/a' 3))
  =/  bc=path  `path`/pub/page/b/c/(scot %uv (page-id:lp 1 '/b/c' 12))
  ;:  weld
    (expect-eq !>((silt `(list path)`~[a1 bc])) !>(got))
    (expect-eq !>(%.n) !>((~(has in got) a2)))
  ==
::  the revision list round-trips, and a row that does not parse is
::  dropped rather than failing the whole list
++  test-revs-json
  =/  revs=(map @t [rev=@ud id=@uv])  (malt ~[['/a' 3 0v1f] ['/b/c' 12 0v2]])
  =/  good=json
    (pairs:enjs:format ~[['rev' n+'3'] ['id' s+'0v1f']])
  ;:  weld
    (expect-eq !>(revs) !>((json-revs:lp (revs-json:lp revs))))
    %+  expect-eq  !>(`(map @t [rev=@ud id=@uv])`(malt ~[['/a' 3 0v1f]]))
    !>((json-revs:lp [%o (malt `(list [@t json])`~[['/a' good] ['/x' n+'3'] ['/y' (pairs:enjs:format ~[['rev' n+'1'] ['id' s+'zz']])]])]))
    (expect-eq !>(`(map @t [rev=@ud id=@uv])`~) !>((json-revs:lp s+'nope')))
  ==
::  +small-noun counts cells as a clam walks them, sharing included, and
::  answers past the cap without walking the rest
++  test-small-noun
  =/  a=*  [1 2]
  =/  d=*  =/  x=*  a  =+  i=0  |-  ?:  =(i 60)  x  $(x [x x], i +(i))
  ;:  weld
    (expect-eq !>(&) !>((small-noun:lp ~[1 2 3] 10)))
    (expect-eq !>(|) !>((small-noun:lp ~[1 2 3] 2)))
    (expect-eq !>(&) !>((small-noun:lp 42 0)))
    (expect-eq !>(|) !>((small-noun:lp d 1.000)))
  ==
::  +pub-due: a throttle with a leading edge. A page not published lately
::  (sent 0, or a gap ago) is due at once; one published inside the gap
::  waits for the gap's end, however often it is saved meanwhile.
++  test-pub-due
  =/  t=@da  ~2026.1.1
  =/  gap=@dr  ~s6
  ;:  weld
    (expect-eq !>(&) !>((lte (pub-due:lp (pub-note:lp ~ t) gap) t)))
    (expect-eq !>((add t gap)) !>((pub-due:lp [t 0 t &] gap)))
    ::  a save 2 s after a publish waits 4 s more, not 6 after the save
    =/  w=pub-wait:lp  (pub-note:lp `[t 0 t |] (add t ~s2))
    (expect-eq !>((add t gap)) !>((pub-due:lp w gap)))
  ==
::  +pub-note: a save makes the row dirty, keeps its last publish and
::  starts the tries again
++  test-pub-note
  =/  t=@da  ~2026.1.1
  ;:  weld
    (expect-eq !>(`pub-wait:lp`[t 0 *@da &]) !>((pub-note:lp ~ t)))
    (expect-eq !>(`pub-wait:lp`[(add t ~s1) 0 t &]) !>((pub-note:lp `[t 2 t |] (add t ~s1))))
  ==
::  +pub-prune keeps every dirty row and a clean one only inside its gap,
::  so the map never holds more than the pages waiting or just published
++  test-pub-prune
  =/  t=@da  ~2026.1.1
  =/  pen=pub-pending:lp
    %-  malt
    ^-  (list [@t pub-wait:lp])
    :~  ['/old' [t 0 t |]]
        ['/new' [t 0 (add t ~s4) |]]
        ['/wait' [t 1 t &]]
    ==
  =/  out  (pub-prune:lp pen (add t ~s7) ~s6)
  ;:  weld
    (expect-eq !>(`(list @t)`~['/new' '/wait']) !>((sort ~(tap in ~(key by out)) aor)))
    (expect-eq !>(pen) !>((pub-prune:lp pen t ~s6)))
  ==
::  +pub-done: a publish leaves the row clean unless a save landed after
::  the publish started, which may have missed the copy
++  test-pub-done
  =/  t=@da  ~2026.1.1
  ;:  weld
    (expect-eq !>(`pub-wait:lp`[t 0 (add t ~s2) |]) !>((pub-done:lp [t 1 *@da &] t (add t ~s2))))
    (expect-eq !>(`pub-wait:lp`[(add t ~s1) 0 (add t ~s2) &]) !>((pub-done:lp [(add t ~s1) 1 *@da &] t (add t ~s2))))
  ==
::  +pub-failed, +pub-drop: only failed publishes count. A page waiting
::  across any number of writer restarts (which arm, never count) stays
::  due and is not dropped; three failures drop it.
++  test-pub-tries
  =/  t=@da  ~2026.1.1
  =/  w=pub-wait:lp  (pub-note:lp ~ t)
  =/  pen=pub-pending:lp  (malt ~[['/a' w]])
  =/  f1  (pub-failed:lp w (add t ~s1))
  =/  f3  (pub-failed:lp (pub-failed:lp f1 (add t ~s8)) (add t ~s15))
  ;:  weld
    ::  ten restarts: each arms the map as it is, due at once
    (expect-eq !>(`(unit @da)``*@da) !>((pub-arm-at:lp pen t ~s6)))
    (expect-eq !>(|) !>((pub-drop:lp (~(got by pen) '/a') 3)))
    (expect-eq !>(`pub-wait:lp`[t 1 (add t ~s1) &]) !>(f1))
    (expect-eq !>(|) !>((pub-drop:lp f1 3)))
    (expect-eq !>(&) !>((pub-drop:lp f3 3)))
  ==
::  +pub-arm-at: the earliest dirty row's time, the epoch when one is due
::  already, and nothing for a map with no dirty row
++  test-pub-arm-at
  =/  t=@da  ~2026.1.1
  =/  gap=@dr  ~s6
  =/  clean=pub-pending:lp  (malt ~[['/c' `pub-wait:lp`[t 0 t |]]])
  =/  later=pub-pending:lp
    (~(put by clean) '/w' `pub-wait:lp`[t 0 (add t ~s2) &])
  =/  due=pub-pending:lp
    (~(put by later) '/d' `pub-wait:lp`[t 0 *@da &])
  ;:  weld
    (expect-eq !>(`(unit @da)`~) !>((pub-arm-at:lp clean t gap)))
    (expect-eq !>(`(unit @da)``(add t ~s8)) !>((pub-arm-at:lp later t gap)))
    (expect-eq !>(`(unit @da)``*@da) !>((pub-arm-at:lp later (add t ~s8) gap)))
    (expect-eq !>(`(unit @da)``*@da) !>((pub-arm-at:lp due t gap)))
  ==
::  +pub-restart: only the page whose attempt was in flight gets a try
::  counted; a restart with nothing in flight counts none, so three
::  attempts that each took their event down drop the page, and any
::  number of plain deploys do not
++  test-pub-restart
  =/  t=@da  ~2026.1.1
  =/  a=pub-wait:lp  [t 0 *@da &]
  =/  pen=pub-pending:lp  (malt ~[['/a' a] ['/b' a]])
  =/  three
    =/  p  (pub-restart:lp pen `'/a')
    =.  p  (pub-restart:lp p `'/a')
    (pub-restart:lp p `'/a')
  ;:  weld
    (expect-eq !>(pen) !>((pub-restart:lp pen ~)))
    (expect-eq !>(pen) !>((pub-restart:lp pen `'/gone')))
    (expect-eq !>(1) !>(tries:(~(got by (pub-restart:lp pen `'/a')) '/a')))
    (expect-eq !>(0) !>(tries:(~(got by (pub-restart:lp pen `'/a')) '/b')))
    (expect-eq !>(&) !>((pub-drop:lp (~(got by three) '/a') 3)))
    ::  a published (clean) row in flight is not counted
    =/  c=pub-pending:lp  (malt ~[['/a' `pub-wait:lp`[t 0 t |]]])
    (expect-eq !>(c) !>((pub-restart:lp c `'/a')))
  ==
::  +builder-mode: tex renders as text; an unknown builder has none
++  test-builder-mode
  ;:  weld
    (expect-eq !>(`(unit @tas)``%text) !>((builder-mode:lp %tex)))
    (expect-eq !>(`(unit @tas)``%md) !>((builder-mode:lp %md)))
    (expect-eq !>(`(unit @tas)``%css) !>((builder-mode:lp %css)))
    (expect-eq !>(`(unit @tas)`~) !>((builder-mode:lp %raw)))
  ==
::  +pub-from-old: release 79's rows still publish, as dirty rows due now
++  test-pub-from-old
  =/  t=@da  ~2026.1.1
  =/  old=pub-old:lp  (malt ~[['/a' [t (add t ~s1) 2]]])
  (expect-eq !>(`pub-pending:lp`(malt ~[['/a' `pub-wait:lp`[(add t ~s1) 2 *@da &]]])) !>((pub-from-old:lp old)))
--
