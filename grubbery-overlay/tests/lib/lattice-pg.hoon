::  Unit tests for /lib/lattice-pg — the page standard library.
::  Run with:  -test /=grubbery=/tests/lib/lattice-pg ~
::
::  +deg-micro / +micro-deg exist so +live-location can compute a map bounding
::  box WITHOUT parsing coordinates as floating point. If they are wrong the
::  page silently renders no map (an empty tape is a valid render), so the
::  round trip is worth pinning.
::
/+  *test, pg=lattice-pg
|%
++  test-deg-micro
  ;:  weld
    (expect-eq !>(`(unit @sd)`[~ (sun:si 51.500.700)]) !>((deg-micro:pg "51.5007")))
    (expect-eq !>(`(unit @sd)`[~ (new:si | 124.600)]) !>((deg-micro:pg "-0.1246")))
    ::  no fractional part at all
    (expect-eq !>(`(unit @sd)`[~ (sun:si 12.000.000)]) !>((deg-micro:pg "12")))
    ::  more than six decimals is truncated, not rejected
    (expect-eq !>(`(unit @sd)`[~ (sun:si 1.234.567)]) !>((deg-micro:pg "1.2345678")))
    ::  junk is refused rather than guessed at
    (expect-eq !>(`(unit @sd)`~) !>((deg-micro:pg "")))
    (expect-eq !>(`(unit @sd)`~) !>((deg-micro:pg "north")))
  ==
::  the round trip is what the bbox depends on
++  test-micro-deg-round-trip
  ;:  weld
    (expect-eq !>("51.500700") !>((micro-deg:pg (sun:si 51.500.700))))
    (expect-eq !>("-0.124600") !>((micro-deg:pg (new:si | 124.600))))
    ::  a small fraction keeps its leading zeros — dropping them would move
    ::  the position by kilometres
    (expect-eq !>("0.000001") !>((micro-deg:pg (sun:si 1))))
  ==
++  test-split-on
  ;:  weld
    (expect-eq !>(`(list tape)`~["a" "b" "c"]) !>((split-on:pg "a,b,c" ',')))
    (expect-eq !>(`(list tape)`~["solo"]) !>((split-on:pg "solo" ',')))
    (expect-eq !>(`(list tape)`~["" ""]) !>((split-on:pg "," ',')))
  ==
--
