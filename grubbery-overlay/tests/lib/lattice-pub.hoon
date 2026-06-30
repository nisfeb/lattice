::  Unit tests for /lib/lattice-pub (pure public-page helpers).  Run with:
::    -test %/tests/lib/lattice-pub ~   (or the run-tests MCP tool)
::
::  Faced import (lp=lattice-pub) rather than wildcard, so `page` and friends
::  can't clash with anything already in the subject.
::
/+  *test, lp=lattice-pub
|%
++  base  `path`/lattice/pub/vault
::  +strip-pub: drops a leading `pub`; leaves a pub-less key untouched.
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
    ::  the home page /pub/index/gmi sits under vault/index — NOT colliding with
    ::  the sibling /pub/index grub (which lives outside the vault subtree).
    (expect-eq !>(`(unit vrail:lp)`[~ /lattice/pub/vault/index %gmi]) !>((key-to-rail:lp base /pub/index/gmi)))
    ::  empty / degenerate key has no leaf to name
    (expect-eq !>(`(unit vrail:lp)`~) !>((key-to-rail:lp base ~)))
  ==
::  +to-pub-row: project a page body onto its index row (now, bytes, sham).
::
++  test-to-pub-row
  ;:  weld
    (expect-eq !>(`pub-row:lp`[~2026.1.1 2 (sham 'hi')]) !>((to-pub-row:lp 'hi' ~2026.1.1)))
    (expect-eq !>(`pub-row:lp`[~2026.2.2 5 (sham 'hello')]) !>((to-pub-row:lp 'hello' ~2026.2.2)))
  ==
::  +derive-pub-index: project every page, keyed identically.
::
++  test-derive-pub-index
  =/  in=(map path page:lp)  (my /pub/a/gmi^'hi' /pub/b/gmi^'hello' ~)
  =/  want=pub-index:lp
    (my /pub/a/gmi^[~2026.1.1 2 (sham 'hi')] /pub/b/gmi^[~2026.1.1 5 (sham 'hello')] ~)
  (expect-eq !>(want) !>((derive-pub-index:lp in ~2026.1.1)))
--
