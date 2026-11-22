::  Unit tests for /lib/lattice-floor. Run with:
::    -test %/tests/lib/lattice-floor ~
::
/+  *test, *lattice-floor
|%
::  +in-life: only revs above the floor are the current grub's, and rev 0
::  is one of them when nothing was there before
++  test-in-life
  ;:  weld
    (expect-eq !>(&) !>((in-life ~ 0)))
    (expect-eq !>(&) !>((in-life ~ 7)))
    (expect-eq !>(|) !>((in-life `3 0)))
    (expect-eq !>(|) !>((in-life `3 3)))
    (expect-eq !>(&) !>((in-life `3 4)))
    ::  a floor of 0: the earlier grub held only rev 0
    (expect-eq !>(|) !>((in-life `0 0)))
    (expect-eq !>(&) !>((in-life `0 1)))
  ==
::  +floor-put: a floor is set, and only ever rises
++  test-floor-put
  =/  k=path  /page/a/code
  =/  one=(map path @ud)  (floor-put ~ k 3)
  ;:  weld
    (expect-eq !>(`3) !>((~(get by one) k)))
    (expect-eq !>(`9) !>((~(get by (floor-put one k 9)) k)))
    (expect-eq !>(one) !>((floor-put one k 2)))
    (expect-eq !>(one) !>((floor-put one k 3)))
    (expect-eq !>(`0) !>((~(get by (floor-put ~ /b 0)) /b)))
  ==
--
