::  Unit tests for /lib/lattice-pg, the page standard library.
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
    ::  a small fraction keeps its leading zeros. Dropping them would move
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
::  it is testable as a pure gate. Feed each result's dat back in as the next
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
    ::  second share from a new position, 0.005 deg away and INSIDE the map's
    ::  0.008-deg half-span. (A first draft moved 0.01 deg and the dot was
    ::  correctly clipped as off-map, which failed the test and proved the
    ::  clipping.) The old position is now the trail. It is drawn as an
    ::  overlay dot, kept in state, never sent to the tile host. The iframe
    ::  src carries only the CURRENT position.
    (expect-eq !>(%.y) !>(?=(^ (find "<circle" b2))))
    (expect-eq !>(%.y) !>(?=(^ (find "51.50000,7.25000" b2))))
    (expect-eq !>(%.y) !>(?=(^ (find "51.50500, 7.25500" b2))))
    ::  stop: no positions, no trail, no map. Current AND past are erased
    (expect-eq !>(%.y) !>(?=(~ (find "51.5" b3))))
    (expect-eq !>(%.y) !>(?=(~ (find "<iframe" b3))))
    (expect-eq !>(%.y) !>(?=(^ (find "No position is being broadcast" b3))))
    ::  expiry (no command, past the deadline): identical erasure. A history
    ::  of where you were is exactly as sensitive as where you are
    (expect-eq !>(%.y) !>(?=(~ (find "51.5" b4))))
    (expect-eq !>(%.y) !>(?=(~ (find "openstreetmap" b4))))
    (expect-eq !>(%.y) !>(?=(^ (find "No position is being broadcast" b4))))
  ==
::  both ends of the digit range, and a byte just below it
++  test-tape-num
  ;:  weld
    (expect-eq !>(`(unit @ud)`[~ 90]) !>((tape-num:pg "90")))
    (expect-eq !>(`(unit @ud)`~) !>((tape-num:pg "/")))
  ==
::  +live-location, one rule per test (hoon-mutate, 2026-09-26: 23 of its
::  mutants survived the flow test above). +ll runs it at t0 unless told
::  otherwise; +body is the render as a tape.
++  t0  ~2026.8.2..10.00.00
++  ll
  |=  [cmd=@t prev=(unit tape) now=@da]
  (live-location:pg ?:(=('' cmd) ~ `cmd) ?~(prev ~ `(crip u.prev)) now /w "W")
++  body  |=(r=result:pg ^-(tape (trip ;;(@t (need dat.r)))))
++  on    |=([n=tape r=result:pg] ?=(^ (find n (body r))))
++  dark  |=(r=result:pg (on "No position is being broadcast" r))
::  a coordinate is digits, '-' and '.', 1 to 24 of them. '<' is above '9'
++  test-loc-coordinates
  ;:  weld
    (expect-eq !>(&) !>((dark (ll 'cmd=,7.25' ~ t0))))
    (expect-eq !>(&) !>((dark (ll 'cmd=<b>,7.25' ~ t0))))
    (expect-eq !>(&) !>((dark (ll 'cmd=51/5,7.25' ~ t0))))
    (expect-eq !>(&) !>((on "-0.1246, 59.9" (ll 'cmd=-0.1246,59.9' ~ t0))))
    (expect-eq !>(&) !>((on "1.0000000000000000000000," (ll (crip "cmd=1.{(reap 22 '0')},7") ~ t0))))
    (expect-eq !>(&) !>((dark (ll (crip "cmd=1.{(reap 23 '0')},7") ~ t0))))
  ==
::  two fields share for the default hour; a third is the accuracy, a fourth
::  the minutes
++  test-loc-fields
  ;:  weld
    (expect-eq !>(`(unit @dr)`[~ ~h1]) !>(wake:(ll 'cmd=51.5,7.25' ~ t0)))
    (expect-eq !>(&) !>((on "accurate to about 10 m" (ll 'cmd=51.5,7.25,10' ~ t0))))
    (expect-eq !>(`(unit @dr)`[~ ~m15]) !>(wake:(ll 'cmd=51.5,7.25,10,15' ~ t0)))
  ==
::  a share ends AT its deadline, not a moment after
++  test-loc-deadline
  =/  b1=tape  (body (ll 'cmd=51.5,7.25,10,15' ~ t0))
  ;:  weld
    (expect-eq !>(&) !>((on "51.5, 7.25" (ll '' `b1 (add t0 (sub ~m15 ~s1))))))
    (expect-eq !>(&) !>((dark (ll '' `b1 (add t0 ~m15)))))
  ==
::  a page stored before the trail existed has four fields, and still shows
++  test-loc-old-state
  =/  old=tape  "<!--loc 51.5|7.25||{(scow %da (add t0 ~h1))}-->"
  (expect-eq !>(&) !>((on "51.5, 7.25" (ll '' `old t0))))
::  the trail keeps every earlier position, and a move in lat OR lon alone
::  files one
++  test-loc-trail
  =/  b1=tape  (body (ll 'cmd=51.50000,7.25000' ~ t0))
  =/  b2=tape  (body (ll 'cmd=51.50100,7.25000' `b1 t0))
  =/  b3=tape  (body (ll 'cmd=51.50100,7.25100' `b2 t0))
  ;:  weld
    (expect-eq !>(&) !>(?=(^ (find "51.50000,7.25000" b2))))
    (expect-eq !>(&) !>(?=(^ (find "51.50100,7.25000;51.50000,7.25000" b3))))
  ==
::  a trail point exactly on the map's edge is drawn; one past it is not
++  test-loc-trail-edge
  =/  b1=tape  (body (ll 'cmd=51.500000,7.25' ~ t0))
  =/  b1x=tape  (body (ll 'cmd=51.499840,7.25' ~ t0))
  ;:  weld
    (expect-eq !>(&) !>((on "cy=\"100\"" (ll 'cmd=51.508000,7.25' `b1 t0))))
    (expect-eq !>(&) !>(?=(~ (find "<circle" (body (ll 'cmd=51.508000,7.25' `b1x t0))))))
  ==
--
