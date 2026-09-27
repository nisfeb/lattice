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
--
