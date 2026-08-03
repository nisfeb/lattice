::  Unit tests for /lib/lattice-urls (the urb:// codec).  Run with:
::    -test /=grubbery=/tests/lib/lattice-urls ~   (or the run-tests MCP tool)
::
::  These enforce the laws docs/urls.md states:
::    de-urb(en-urb(node)) == node          (round-trips to the same referent)
::    en-urb(de-urb(url))  == canon(url)    (idempotent text normalization)
::
/+  *test, lu=lattice-urls
|%
++  zod  ~zod
::  +parse-urb-url: the legacy fetch-route parser.
::
++  test-parse-urb-url
  ;:  weld
    %+  expect-eq
      !>  `(unit [ship path])``[~zod /notes/intro]
      !>  (parse-urb-url:lu 'urb://~zod/notes/intro')
    (expect-eq !>(`(unit [ship path])``[~zod ~]) !>((parse-urb-url:lu 'urb://~zod')))
    (expect-eq !>(`(unit [ship path])`~) !>((parse-urb-url:lu 'https://example.com')))
    (expect-eq !>(`(unit [ship path])`~) !>((parse-urb-url:lu 'urb://notaship/x')))
  ==
::  +de-urb mounts: one-char selects a mount, anything else is legacy pub,
::  an unassigned letter is a hard error (never a fallthrough).
::
++  test-de-urb-mounts
  ;:  weld
    ::  bare ship -> the published front door
    (expect-eq !>(`(unit referent:lu)``[%pub zod /index]) !>((de-urb:lu 'urb://~zod')))
    (expect-eq !>(`(unit referent:lu)``[%pub zod /index]) !>((de-urb:lu 'urb://~zod/')))
    ::  multi-char first component -> frozen legacy pub form
    %+  expect-eq
      !>  `(unit referent:lu)``[%pub zod /notes/'2026'/intro]
      !>  (de-urb:lu 'urb://~zod/notes/2026/intro')
    ::  the four mounts
    %+  expect-eq
      !>  `(unit referent:lu)``[%tree zod (weld page-prefix:lu /counter)]
      !>  (de-urb:lu 'urb://~zod/p/counter')
    (expect-eq !>(`(unit referent:lu)``[%pub zod /notes]) !>((de-urb:lu 'urb://~zod/n/notes')))
    %+  expect-eq
      !>  `(unit referent:lu)``[%tree zod (weld know-prefix:lu /user/prefs)]
      !>  (de-urb:lu 'urb://~zod/k/user/prefs')
    %+  expect-eq
      !>  `(unit referent:lu)``[%tree zod /apps/'obelisk.obelisk_app']
      !>  (de-urb:lu 'urb://~zod/t/apps/obelisk.obelisk_app')
    ::  an unassigned single letter is invalid, not a store
    (expect-eq !>(`(unit referent:lu)`~) !>((de-urb:lu 'urb://~zod/x/foo')))
    (expect-eq !>(`(unit referent:lu)`~) !>((de-urb:lu 'urb://~zod/b')))
  ==
::  +en-urb canonical choices: pages -> /p/, know -> /k/, pub bare (or /n/ when
::  a single-char top segment forces the explicit form), raw tree -> /t/.
::
++  test-en-urb-canonical
  ;:  weld
    (expect-eq !>('urb://~zod/p/counter') !>((en-urb:lu zod (weld page-prefix:lu /counter))))
    (expect-eq !>('urb://~zod/k/user/prefs') !>((en-urb:lu zod (weld know-prefix:lu /user/prefs))))
    ::  published notes canonicalize BARE, so federation urls stay pretty
    (expect-eq !>('urb://~zod/notes/intro') !>((en-urb:lu zod (weld pub-prefix:lu /notes/intro))))
    ::  the index and the vault root are the bare ship
    (expect-eq !>('urb://~zod') !>((en-urb:lu zod (weld pub-prefix:lu /index))))
    (expect-eq !>('urb://~zod') !>((en-urb:lu zod pub-prefix:lu)))
    ::  a single-char top segment cannot use the bare form (it would read as a
    ::  mount), so it canonicalizes to the explicit /n/
    (expect-eq !>('urb://~zod/n/x/y') !>((en-urb:lu zod (weld pub-prefix:lu /x/y))))
    ::  anything else is the /t/ escape hatch
    (expect-eq !>('urb://~zod/t/apps/foo.foo') !>((en-urb:lu zod /apps/'foo.foo')))
  ==
::  Law 1: de-urb(en-urb(node)) names the same referent, for a node in every
::  canonical class.
::
++  test-law-node-roundtrip
  =/  nodes=(list path)
    :~  (weld page-prefix:lu /counter)
        (weld page-prefix:lu /counter/data)
        (weld know-prefix:lu /user/prefs)
        /apps/'obelisk.obelisk_app'/main
    ==
  %+  roll  nodes
  |=  [pax=path acc=tang]
  %+  weld  acc
  %+  expect-eq
    !>  `(unit referent:lu)``[%tree zod pax]
    !>  (de-urb:lu (en-urb:lu zod pax))
::  Law 1 for pub nodes: the referent comes back as %pub with the vault-relative
::  path (bare, /n/, and index forms all included).
::
++  test-law-pub-roundtrip
  =/  rels=(list path)
    ~[/notes/intro /readme /x/y /index]
  %+  roll  rels
  |=  [rel=path acc=tang]
  %+  weld  acc
  %+  expect-eq
    !>  `(unit referent:lu)``[%pub zod rel]
    !>  (de-urb:lu (en-urb:lu zod (weld pub-prefix:lu rel)))
::  Law 2: en-urb over a decoded url is idempotent text normalization. The
::  aliased /t/ spelling of a page canonicalizes to /p/, and canonical text is
::  a fixed point.
::
++  test-law-canon-idempotent
  =/  alias=@t  'urb://~zod/t/apps/lattice.lattice_app/page/counter'
  =/  canon=@t  'urb://~zod/p/counter'
  =/  d=(unit referent:lu)  (de-urb:lu alias)
  ;:  weld
    ::  the alias decodes to the same node the canonical form names
    (expect-eq !>((de-urb:lu canon)) !>(d))
    ::  re-encoding lands on the canonical spelling
    %+  expect-eq  !>(canon)
    !>  ?>  ?=([~ %tree *] d)
        (en-urb:lu ship.u.d pax.u.d)
    ::  and the canonical spelling is a fixed point
    %+  expect-eq  !>(canon)
    !>  =/  d2=(unit referent:lu)  (de-urb:lu canon)
        ?>  ?=([~ %tree *] d2)
        (en-urb:lu ship.u.d2 pax.u.d2)
  ==
--
