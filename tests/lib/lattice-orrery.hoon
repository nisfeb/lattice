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
::  journal-merge: a re-mirrored brief keeps the owner's ticks and notes
++  test-merge-keeps-tick
  %+  expect-eq
    !>('# Brief, d\0a\0a- [x] Call Sam [T1]\0a- [ ] Ship it [T2]')
  !>  %+  journal-merge:lo
    '# Brief, d\0a\0a- [x] Call Sam [T1]\0a- [ ] Ship it [T2]'
  '# Brief, d\0a\0a- [ ] Call Sam [T1]\0a- [ ] Ship it [T2]'
++  test-merge-capital-x
  %+  expect-eq  !>('- [x] a [T3]')
  !>((journal-merge:lo '- [X] a [T3]' '- [ ] a [T3]'))
++  test-merge-new-text-drops-tick
  ::  a remade brief gave T1 to another task: the tick is not carried
  %+  expect-eq  !>('- [ ] Other task [T1]')
  !>((journal-merge:lo '- [x] Call Sam [T1]' '- [ ] Other task [T1]'))
++  test-merge-untagged-not-carried
  %+  expect-eq  !>('- [ ] plain')
  !>((journal-merge:lo '- [x] plain' '- [ ] plain'))
++  test-merge-orrery-done-stays
  %+  expect-eq  !>('- [x] a [T1]')
  !>((journal-merge:lo '- [ ] a [T1]' '- [x] a [T1]'))
++  test-merge-line-moved
  %+  expect-eq  !>('intro\0a\0a- [ ] b [T2]\0a- [x] a [T1]')
  !>((journal-merge:lo '- [x] a [T1]\0a- [ ] b [T2]' 'intro\0a\0a- [ ] b [T2]\0a- [x] a [T1]'))
++  test-merge-crlf
  %+  expect-eq  !>('- [x] a [T1]')
  !>((journal-merge:lo '- [x] a [T1]\0d\0a' '- [ ] a [T1]'))
++  test-merge-crlf-new
  ;:  weld
    (expect-eq !>('- [x] a [T1]') !>((journal-merge:lo '- [x] a [T1]' '- [ ] a [T1]\0d')))
    %+  expect-eq  !>('x\0a## Notes\0atheirs')
    !>((journal-merge:lo 'x\0a## Notes\0amine' 'x\0d\0a## Notes\0d\0atheirs'))
  ==
++  test-merge-quoted-and-numbered
  %+  expect-eq  !>('> 1. [x] a [T4]')
  !>((journal-merge:lo '> 1. [x] a [T4]' '> 1. [ ] a [T4]'))
++  test-merge-keeps-notes
  %+  expect-eq  !>('# Brief\0a\0a- [x] a [T1]\0a\0a## Notes\0a\0acalled at 3')
  !>((journal-merge:lo '# Brief\0a\0a- [x] a [T1]\0a\0a## Notes\0a\0acalled at 3' '# Brief\0a\0a- [ ] a [T1]'))
++  test-merge-notes-not-doubled
  %+  expect-eq  !>('x\0a## Notes\0anew')
  !>((journal-merge:lo 'x\0a## Notes\0aold' 'x\0a## Notes\0anew'))
++  test-merge-other-edits-replaced
  %+  expect-eq  !>('# Brief\0a\0afresh text')
  !>((journal-merge:lo '# Brief\0a\0amy edit' '# Brief\0a\0afresh text'))
++  test-task-at
  ;:  weld
    (expect-eq !>(`3) !>((task-at:lo "- [ ] a")))
    (expect-eq !>(`5) !>((task-at:lo "> * [x] a")))
    (expect-eq !>(`5) !>((task-at:lo "12) [ ] a")))
    (expect-eq !>(~) !>((task-at:lo "- [ ]")))
    (expect-eq !>(~) !>((task-at:lo "-[ ] a")))
    (expect-eq !>(~) !>((task-at:lo "- [y] a")))
    (expect-eq !>(~) !>((task-at:lo "text [ ] a")))
  ==
++  test-has-tag
  ;:  weld
    (expect-eq !>(&) !>((has-tag:lo "a [T12]")))
    (expect-eq !>(|) !>((has-tag:lo "a [T]")))
    (expect-eq !>(|) !>((has-tag:lo "a [Tx]")))
  ==
--
