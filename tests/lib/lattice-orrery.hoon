::  Unit tests for /lib/lattice-orrery (pure orrery read-side helpers).
::
/+  *test, lo=lattice-orrery
|%
++  test-rewrite-id
  %+  expect-eq  !>("[[situation/x]]")
  !>((brief-link-rewrite:lo "[situation/x]"))
++  test-rewrite-skips-tag
  %+  expect-eq  !>("[tag] [a1]")
  !>((brief-link-rewrite:lo "[tag] [a1]"))
++  test-rewrite-mixed
  %+  expect-eq  !>("see [[person/sarah]] and [tag] on [[situation/x]].")
  !>((brief-link-rewrite:lo "see [person/sarah] and [tag] on [situation/x]."))
++  test-rewrite-no-double
  %+  expect-eq  !>("[[situation/x]] [t](a/b)")
  !>((brief-link-rewrite:lo "[[situation/x]] [t](a/b)"))
++  test-journal-body
  %+  expect-eq  !>('# Brief, 2026.10.19\0a\0asee [[situation/x]]')
  !>((journal-body:lo "Brief" '2026.10.19' 'see [situation/x]'))
++  test-fresh-yes
  %+  expect-eq  !>(&)
  !>((fresh-world:lo '2026-10-19T10:00:00Z' ~2026.10.19..12.00.00 ~d1))
++  test-fresh-no
  %+  expect-eq  !>(|)
  !>((fresh-world:lo '2026-10-17T10:00:00Z' ~2026.10.19..12.00.00 ~d1))
++  test-fresh-skew
  %+  expect-eq  !>(&)
  !>((fresh-world:lo '2026-10-19T13:00:00Z' ~2026.10.19..12.00.00 ~d1))
++  test-fresh-malformed
  %+  expect-eq  !>(|)
  !>((fresh-world:lo 'garbage' ~2026.10.19..12.00.00 ~d1))
--
