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
::  journal-fold: a new brief folded into a page the owner edited. All
::  owner text stays; only [T<n>] lines move.
++  test-fold-keeps-tick
  %+  expect-eq
    !>('# Brief, d\0a\0a- [x] Call Sam [T1]\0a- [ ] Ship it [T2]')
  !>  %+  journal-fold:lo
    '# Brief, d\0a\0a- [x] Call Sam [T1]\0a- [ ] Ship it [T2]'
  '# Brief, d\0a\0a- [ ] Call Sam [T1]\0a- [ ] Ship it [T2]'
++  test-fold-capital-x
  %+  expect-eq  !>('- [x] a [T3]')
  !>((journal-fold:lo '- [X] a [T3]' '- [ ] a [T3]'))
++  test-fold-new-text-drops-tick
  ::  a remade brief gave T1 to another task: its line, unticked
  %+  expect-eq  !>('- [ ] Other task [T1]')
  !>((journal-fold:lo '- [x] Call Sam [T1]' '- [ ] Other task [T1]'))
++  test-fold-orrery-done-stays
  %+  expect-eq  !>('- [x] a [T1]')
  !>((journal-fold:lo '- [ ] a [T1]' '- [x] a [T1]'))
++  test-fold-crlf
  ;:  weld
    (expect-eq !>('- [x] a [T1]\0a') !>((journal-fold:lo '- [x] a [T1]\0d\0a' '- [ ] a [T1]')))
    (expect-eq !>('- [x] a [T1]') !>((journal-fold:lo '- [x] a [T1]' '- [ ] a [T1]\0d')))
  ==
++  test-fold-quoted-and-numbered
  %+  expect-eq  !>('> 1. [x] a [T4]')
  !>((journal-fold:lo '> 1. [x] a [T4]' '> 1. [ ] a [T4]'))
::  the owner's own lines, headings and notes all stay, wherever they are
++  test-fold-keeps-owner-text
  %+  expect-eq
    !>('# My day\0a\0amy edit\0a- [x] a [T1]\0aplain owner line\0a\0a## Notes\0a\0acalled at 3')
  !>  %+  journal-fold:lo
    '# My day\0a\0amy edit\0a- [x] a [T1]\0aplain owner line\0a\0a## Notes\0a\0acalled at 3'
  '# Brief\0a\0afresh text\0a- [ ] a [T1]'
::  a tag the page lacks goes in before its Notes heading, any level or case
++  test-fold-new-tag-before-notes
  ;:  weld
    %+  expect-eq  !>('- [ ] a [T1]\0a- [ ] b [T2]\0a### notes \0amine')
    !>((journal-fold:lo '- [ ] a [T1]\0a### notes \0amine' '- [ ] a [T1]\0a- [ ] b [T2]'))
    %+  expect-eq  !>('x\0a- [ ] b [T2]\0a# NOTES\0amine')
    !>((journal-fold:lo 'x\0a# NOTES\0amine' '- [ ] b [T2]'))
    ::  no heading: at the end
    %+  expect-eq  !>('x\0a- [ ] b [T2]')
    !>((journal-fold:lo 'x' '- [ ] b [T2]'))
  ==
::  a tag the brief no longer has keeps the owner's line
++  test-fold-dropped-tag-kept
  %+  expect-eq  !>('- [x] a [T1]\0a- [ ] b [T2]')
  !>((journal-fold:lo '- [x] a [T1]' '- [ ] b [T2]'))
++  test-notes-head
  ;:  weld
    (expect-eq !>(&) !>((notes-head:lo "## Notes")))
    (expect-eq !>(&) !>((notes-head:lo "### NOTES  ")))
    (expect-eq !>(&) !>((notes-head:lo "  # notes")))
    (expect-eq !>(|) !>((notes-head:lo "##Notes")))
    (expect-eq !>(|) !>((notes-head:lo "####### Notes")))
    (expect-eq !>(|) !>((notes-head:lo "## Notes on x")))
  ==
++  test-tag-of
  ;:  weld
    (expect-eq !>(`"T12") !>((tag-of:lo "- [ ] a [T12] [T3]")))
    (expect-eq !>(~) !>((tag-of:lo "a [T] [Tx]")))
    (expect-eq !>(`"T3") !>((tag-of:lo "[T] [T3]")))
  ==
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
