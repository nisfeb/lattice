::  Unit tests for /lib/lattice-mirror (the obelisk commons mirror).
::  Run with:
::    -test %/tests/lib/lattice-mirror ~
::
/+  *test, *lattice-mirror
|%
++  test-fresh-of
  ;:  weld
    ::  every probe found its table
    (expect-eq !>(`(set @ud)`~) !>((fresh-of ~[| | |] ~)))
    ::  a wipe: missing and created
    (expect-eq !>(`(set @ud)`(silt ~[0 2])) !>((fresh-of ~[& | &] ~)))
    ::  a probe error meant for someone else: the create failed, the
    ::  table was there, so its cursor stays
    (expect-eq !>(`(set @ud)`(silt ~[2])) !>((fresh-of ~[& | &] (silt ~[0]))))
    ::  a failed create on a table the probe found changes nothing
    (expect-eq !>(`(set @ud)`~) !>((fresh-of ~[| |] (silt ~[1]))))
  ==
++  test-visit-deletes
  =/  a=[@p path]  [~zod /page/a]
  =/  b=[@p path]  [~zod /page/b]
  =/  c=[@p path]  [~nec /page/a]
  ;:  weld
    (expect-eq !>(`(list tape)`~) !>((visit-deletes ~ ~[a b])))
    (expect-eq !>(~[(weld "DELETE FROM lattice-visits WHERE doc-id = " (weld (doc-id a) ";"))]) !>((visit-deletes ~[a] ~[b])))
    ::  a document a current row still holds stays
    (expect-eq !>(`(list tape)`~) !>((visit-deletes ~[a] ~[a b])))
    ::  one delete per document, whatever the urls
    (expect-eq !>(2) !>((lent (visit-deletes ~[a a c] ~[b]))))
  ==
--
