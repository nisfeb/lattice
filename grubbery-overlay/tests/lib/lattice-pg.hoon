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
::  +live-location is a state machine whose state is its own last render, so
::  it is testable as a pure gate: feed each result's dat back in as the next
::  call's dat. What matters most is what each state REFUSES to contain.
::
++  test-live-location-flow
  =/  t0=@da  ~2026.8.2..10.00.00
  =/  r1  (live-location:pg [~ 'cmd=51.50000,7.25000,10,60'] ~ t0 /w "W")
  =/  b1=tape  (trip ;;(@t (need dat.r1)))
  =/  r2  (live-location:pg [~ 'cmd=51.50500,7.25500,10,60'] [~ (crip b1)] (add t0 ~m5) /w "W")
  =/  b2=tape  (trip ;;(@t (need dat.r2)))
  =/  r3  (live-location:pg [~ 'cmd=stop'] [~ (crip b2)] (add t0 ~m10) /w "W")
  =/  b3=tape  (trip ;;(@t (need dat.r3)))
  =/  r4  (live-location:pg ~ [~ (crip b2)] (add t0 ~d1) /w "W")
  =/  b4=tape  (trip ;;(@t (need dat.r4)))
  ;:  weld
    ::  first share: position renders, no trail yet, wake armed for expiry
    (expect-eq !>(%.y) !>(?=(^ (find "51.50000, 7.25000" b1))))
    (expect-eq !>(%.y) !>(?=(~ (find "<circle" b1))))
    (expect-eq !>(%.y) !>(?=(^ wake.r1)))
    ::  second share from a new position (0.005 deg away — INSIDE the map's
    ::  0.008-deg half-span; a first draft moved 0.01 deg and the dot was
    ::  correctly clipped as off-map, which failed the test and proved the
    ::  clipping): the old position is now the trail —
    ::  drawn as an overlay dot, kept in state, never sent to the tile host
    ::  (the iframe src carries only the CURRENT position)
    (expect-eq !>(%.y) !>(?=(^ (find "<circle" b2))))
    (expect-eq !>(%.y) !>(?=(^ (find "51.50000,7.25000" b2))))
    (expect-eq !>(%.y) !>(?=(^ (find "51.50500, 7.25500" b2))))
    ::  stop: no positions, no trail, no map — current AND past are erased
    (expect-eq !>(%.y) !>(?=(~ (find "51.5" b3))))
    (expect-eq !>(%.y) !>(?=(~ (find "<iframe" b3))))
    (expect-eq !>(%.y) !>(?=(^ (find "No position is being broadcast" b3))))
    ::  expiry (no command, past the deadline): identical erasure — a history
    ::  of where you were is exactly as sensitive as where you are
    (expect-eq !>(%.y) !>(?=(~ (find "51.5" b4))))
    (expect-eq !>(%.y) !>(?=(~ (find "openstreetmap" b4))))
    (expect-eq !>(%.y) !>(?=(^ (find "No position is being broadcast" b4))))
  ==
--
