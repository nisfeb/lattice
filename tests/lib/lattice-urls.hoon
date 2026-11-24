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
    ::  a folder's trailing slash names the folder
    %+  expect-eq
      !>  `(unit referent:lu)``[%pub zod /site]
      !>  (de-urb:lu 'urb://~zod/site/')
    %+  expect-eq
      !>  `(unit referent:lu)``[%tree zod (weld page-prefix:lu /docs)]
      !>  (de-urb:lu 'urb://~zod/p/docs/')
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
::  urb://<ship>/forum/<board>[/<post>] names a public forum board (or one
::  post), matched before the legacy multi-char pub fallback.
::
++  test-de-urb-forum
  ;:  weld
    %+  expect-eq
      !>  `(unit referent:lu)``[%forum zod %myboard ~]
      !>  (de-urb:lu 'urb://~zod/forum/myboard')
    %+  expect-eq
      !>  `(unit referent:lu)``[%forum zod %myboard `12]
      !>  (de-urb:lu 'urb://~zod/forum/myboard/12')
    %+  expect-eq
      !>  `(unit referent:lu)``[%forum zod %myboard ~]
      !>  (de-urb:lu 'urb://~zod/forum/myboard/')
    ::  a thread numbered 1000 or more, written plain as every link
    ::  prints it, and with hoon's dots: both are that thread
    %+  expect-eq
      !>  `(unit referent:lu)``[%forum zod %myboard `1.234]
      !>  (de-urb:lu 'urb://~zod/forum/myboard/1234')
    %+  expect-eq
      !>  `(unit referent:lu)``[%forum zod %myboard `1.234]
      !>  (de-urb:lu 'urb://~zod/forum/myboard/1.234')
    ::  a plain page url is still the legacy pub form
    %+  expect-eq
      !>  `(unit referent:lu)``[%pub zod /notes/todo]
      !>  (de-urb:lu 'urb://~zod/notes/todo')
  ==
::  +ud-any reads a number plain or dotted, and nothing else.
::
++  test-ud-any
  ;:  weld
    (expect-eq !>(`(unit @ud)``12) !>((ud-any:lu '12')))
    (expect-eq !>(`(unit @ud)``1.000) !>((ud-any:lu '1000')))
    (expect-eq !>(`(unit @ud)``1.000) !>((ud-any:lu '1.000')))
    (expect-eq !>(`(unit @ud)``1.234.567) !>((ud-any:lu '1234567')))
    (expect-eq !>(`(unit @ud)``0) !>((ud-any:lu '0')))
    (expect-eq !>(`(unit @ud)`~) !>((ud-any:lu '')))
    (expect-eq !>(`(unit @ud)`~) !>((ud-any:lu 'x12')))
    (expect-eq !>(`(unit @ud)`~) !>((ud-any:lu '12x')))
    (expect-eq !>(`(unit @ud)`~) !>((ud-any:lu '-3')))
  ==
::  a published page under forum/ keeps its /n/ escape, so it never aliases a board.
::
++  test-forum-page-escapes
  ;:  weld
    %+  expect-eq
      !>  'urb://~zod/n/forum/x'
      !>  (en-urb:lu zod (weld pub-prefix:lu /forum/x))
    %+  expect-eq
      !>  `(unit referent:lu)``[%pub zod /forum/x]
      !>  (de-urb:lu (en-urb:lu zod (weld pub-prefix:lu /forum/x)))
    %+  expect-eq
      !>  `(unit referent:lu)``[%forum zod %x ~]
      !>  (de-urb:lu 'urb://~zod/forum/x')
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
::
::  +fold-base / +unfold-base: the codec speaks +app-base on every tier; the
::  app folds a physical path in and unfolds a decoded one out. The case is
::  the report's: a desk-tier page that de-urb sent to the app-base path,
::  which 404s there, and that en-urb named /t/ instead of /p/.
::
++  desk-page  `path`(weld desk-base:lu /page/site/talon/index)
++  test-fold-names-a-desk-page-p
  ;:  weld
    (expect-eq !>(`path`(weld app-base:lu /page/site/talon/index)) !>((fold-base:lu desk-base:lu desk-page)))
    %+  expect-eq  !>('urb://~nisfeb/p/site/talon/index')
    !>((en-urb:lu ~nisfeb (fold-base:lu desk-base:lu desk-page)))
  ==
++  test-unfold-reaches-the-desk-page
  =/  r=(unit referent:lu)  (de-urb:lu 'urb://~nisfeb/p/site/talon/index')
  ?>  ?=([~ %tree *] r)
  (expect-eq !>(desk-page) !>((unfold-base:lu desk-base:lu pax.u.r)))
::  the url round-trips through the fold, and so does the physical path
++  test-fold-round-trips
  =/  url=@t  (en-urb:lu ~nisfeb (fold-base:lu desk-base:lu desk-page))
  =/  r=(unit referent:lu)  (de-urb:lu url)
  ?>  ?=([~ %tree *] r)
  ;:  weld
    (expect-eq !>(desk-page) !>((unfold-base:lu desk-base:lu pax.u.r)))
    %+  expect-eq  !>(`path`(weld app-base:lu /know/vault/a))
    !>((fold-base:lu desk-base:lu (unfold-base:lu desk-base:lu (weld app-base:lu /know/vault/a))))
  ==
::  a path outside the base passes through both ways, and on the app tier
::  (base = app-base) both are the identity
++  test-fold-passes-other-paths
  ;:  weld
    (expect-eq !>(`path`/sys/link/lattice) !>((fold-base:lu desk-base:lu /sys/link/lattice)))
    (expect-eq !>(`path`/sys/link/lattice) !>((unfold-base:lu desk-base:lu /sys/link/lattice)))
    (expect-eq !>(desk-page) !>((fold-base:lu app-base:lu desk-page)))
    (expect-eq !>(`path`(weld app-base:lu /page/x)) !>((unfold-base:lu app-base:lu (weld app-base:lu /page/x))))
  ==
::  /unsub drops the keep at every base a /sub may have kept it at: the
::  sub fiber's own keep dir is among them, whichever base it found
++  test-sub-drop-dirs-cover-the-keep
  =/  rel=path  /notes/intro
  =/  dirs=(list path)  (sub-drop-dirs:lu rel)
  ;:  weld
    %+  expect-eq
      !>  `(list path)`~[(weld desk-base:lu /pub/vault/notes/intro) (weld desk-base-old:lu /pub/vault/notes/intro) (weld app-base:lu /pub/vault/notes/intro)]
      !>  dirs
    %-  expect
    !>  (levy peer-bases:lu |=(b=path ?=(^ (find ~[(sub-keep-dir:lu b rel)] dirs))))
  ==
::  /sys/link dest.lanes: develop's ordered list and dist's set both read,
::  directory lanes only, in claim order; junk reads as none
++  test-lane-dirs
  ;:  weld
    %+  expect-eq  !>(`(list path)`~[/apps/a /apps/b])
      !>((lane-dirs:lu `(list (each * path))`~[[%| /apps/a] [%& [/x %f]] [%| /apps/b]]))
    %+  expect-eq  !>(`(list path)`~[/apps/a])
      !>((lane-dirs:lu (silt `(list (each * path))`~[[%| /apps/a]])))
    %+  expect-eq  !>(2)
      !>((lent (lane-dirs:lu (silt `(list (each * path))`~[[%| /apps/a] [%| /apps/b]]))))
    %+  expect-eq  !>(`(list path)`~)
      !>((lane-dirs:lu 42))
    %+  expect-eq  !>(`(list path)`~)
      !>((lane-dirs:lu ~))
  ==
::  +cross-site: Fetch Metadata decides when present; otherwise Origin
::  against Host; neither is a non-browser client
++  test-cross-site
  =/  y  |=([s=(unit @t) o=(unit @t) h=(unit @t)] (cross-site:lu s o h))
  ;:  weld
    ::  the owner's own page, a typed navigation, a granted extension
    (expect-eq !>(|) !>((y `'same-origin' `'https://sampel.arvo.network' `'sampel.arvo.network')))
    (expect-eq !>(|) !>((y `'none' ~ `'sampel.arvo.network')))
    (expect-eq !>(|) !>((y `'none' `'chrome-extension://abc' `'sampel.arvo.network')))
    (expect-eq !>(|) !>((y `'Same-Origin' ~ ~)))
    ::  another site, or another origin on the same site
    (expect-eq !>(&) !>((y `'cross-site' `'https://evil.example' `'sampel.arvo.network')))
    (expect-eq !>(&) !>((y `'same-site' `'https://other.arvo.network' `'sampel.arvo.network')))
    ::  plain http to a LAN host: no Fetch Metadata, so Origin decides
    (expect-eq !>(|) !>((y ~ `'http://192.168.1.5:8080' `'192.168.1.5:8080')))
    (expect-eq !>(|) !>((y ~ `'HTTP://Ship.Local:8080' `'ship.local:8080')))
    (expect-eq !>(&) !>((y ~ `'http://evil.example' `'192.168.1.5:8080')))
    (expect-eq !>(&) !>((y ~ `'http://192.168.1.5:9999' `'192.168.1.5:8080')))
    (expect-eq !>(&) !>((y ~ `'null' `'192.168.1.5:8080')))
    (expect-eq !>(&) !>((y ~ `'http://192.168.1.5:8080' ~)))
    ::  a non-browser client sends neither
    (expect-eq !>(|) !>((y ~ ~ `'sampel.arvo.network')))
    (expect-eq !>(|) !>((y ~ ~ ~)))
  ==
::  +known-base: the recorded base, else desk-base; a junk record is none
++  test-known-base
  =/  k=(map @t json)
    %-  my
    :~  ['~nec' s+'/apps/lattice']
        ['~bud' n+'1']
    ==
  ;:  weld
    (expect-eq !>(/apps/lattice) !>((known-base:lu k ~nec)))
    (expect-eq !>(desk-base:lu) !>((known-base:lu k ~bud)))
    (expect-eq !>(desk-base:lu) !>((known-base:lu k ~wes)))
  ==
++  test-shell-moved
  =/  r=path  /page/temp/notes/code
  ;:  weld
    (expect-eq !>(`(weld desk-base:lu r)) !>((shell-moved:lu (weld desk-base-old:lu r))))
    ::  never onto another layout, nor from the current spelling
    (expect-eq !>(~) !>((shell-moved:lu (weld app-base:lu r))))
    (expect-eq !>(~) !>((shell-moved:lu (weld desk-base:lu r))))
  ==
++  test-moved-path
  =/  old=path  (weld desk-base-old:lu /page/temp/notes/code)
  =/  new=path  (weld desk-base:lu /page/temp/notes/code)
  ;:  weld
    ::  a path under the shell's old spelling reads under the new one
    (expect-eq !>(`new) !>((moved-path:lu desk-base:lu old)))
    ::  and back, for a peer still on the older kernel
    (expect-eq !>(`old) !>((moved-path:lu desk-base-old:lu new)))
    ::  the ball instance's layout moves too
    (expect-eq !>(`new) !>((moved-path:lu desk-base:lu (weld app-base:lu /page/temp/notes/code))))
    ::  already there: nothing to try
    (expect-eq !>(~) !>((moved-path:lu desk-base:lu new)))
    ::  not lattice's at all: left alone
    (expect-eq !>(~) !>((moved-path:lu desk-base:lu /apps/other/thing)))
  ==
::  +save-moved: only a save that reached no one, at a path under one of
::  the layouts lattice runs at, is tried again where the peer moved it
++  test-save-moved
  =/  old=path  (weld desk-base-old:lu /page/temp/notes/code)
  =/  new=path  (weld desk-base:lu /page/temp/notes/code)
  =/  app=path  (weld app-base:lu /page/temp/notes/code)
  ;:  weld
    ::  nothing sent and no answer, under any layout
    (expect-eq !>(&) !>((save-moved:lu 504 | ~s1 ~s10 old)))
    (expect-eq !>(&) !>((save-moved:lu 504 | ~s1 ~s10 new)))
    (expect-eq !>(&) !>((save-moved:lu 504 | ~s1 ~s10 app)))
    ::  the host has no such file there: nothing was written, and a
    ::  kernel that moved the shell answers so at the old path. An
    ::  answer is not a timeout, so the deadline does not matter
    (expect-eq !>(&) !>((save-moved:lu 404 | ~s1 ~s10 old)))
    (expect-eq !>(&) !>((save-moved:lu 404 & ~s1 ~s10 old)))
    (expect-eq !>(&) !>((save-moved:lu 404 | ~s10 ~s10 old)))
    (expect-eq !>(|) !>((save-moved:lu 404 | ~s1 ~s10 /apps/other/thing)))
    ::  sent and not acked: it may still land where it went
    (expect-eq !>(|) !>((save-moved:lu 504 & ~s1 ~s10 old)))
    ::  any answer from the host is final
    (expect-eq !>(|) !>((save-moved:lu 409 | ~s1 ~s10 old)))
    (expect-eq !>(|) !>((save-moved:lu 502 | ~s1 ~s10 old)))
    (expect-eq !>(|) !>((save-moved:lu 403 | ~s1 ~s10 old)))
    (expect-eq !>(|) !>((save-moved:lu 202 | ~s1 ~s10 old)))
    (expect-eq !>(|) !>((save-moved:lu 415 | ~s1 ~s10 old)))
    ::  not lattice's: nowhere else to try
    (expect-eq !>(|) !>((save-moved:lu 504 | ~s1 ~s10 /apps/other/thing)))
    ::  the read ran its whole deadline: the peer is offline, and one
    ::  timeout is all it costs
    (expect-eq !>(|) !>((save-moved:lu 504 | ~s10 ~s10 old)))
    (expect-eq !>(|) !>((save-moved:lu 504 | ~s11 ~s10 new)))
  ==
::  +subresource: Fetch Metadata names what a request is for. Only a
::  document (a navigation) or a client that sends no such header passes.
++  test-subresource
  ;:  weld
    (expect-eq !>(|) !>((subresource:lu ~)))
    (expect-eq !>(|) !>((subresource:lu `'document')))
    (expect-eq !>(|) !>((subresource:lu `'Document')))
    (expect-eq !>(&) !>((subresource:lu `'image')))
    (expect-eq !>(&) !>((subresource:lu `'iframe')))
    (expect-eq !>(&) !>((subresource:lu `'empty')))
    (expect-eq !>(&) !>((subresource:lu `'style')))
    (expect-eq !>(&) !>((subresource:lu `'')))
  ==
::  +valid-utf8: accepts valid RFC 3629 UTF-8 and rejects binary/invalid bytes.
++  test-valid-utf8
  ;:  weld
    (expect-eq !>(&) !>((valid-utf8:lu '')))
    (expect-eq !>(&) !>((valid-utf8:lu 'hello world\0a')))
    ::  2-byte (U+00E9 'e' with acute), 3-byte (U+2014), 4-byte (U+1F600)
    (expect-eq !>(&) !>((valid-utf8:lu `@t`0xa9c3)))
    (expect-eq !>(&) !>((valid-utf8:lu `@t`0x94.80e2)))
    (expect-eq !>(&) !>((valid-utf8:lu `@t`0x8098.9ff0)))
    ::  lone continuation, 0xff/0xfe (AppleDouble binary sidecar bytes)
    (expect-eq !>(|) !>((valid-utf8:lu `@t`0x80)))
    (expect-eq !>(|) !>((valid-utf8:lu `@t`0xfeff.0716.0500)))
    ::  overlong 2-byte (0xc0 0x80), 3-byte (0xe0 0x80 0xaf), 4-byte (0xf0 0x80 0x80 0xaf)
    (expect-eq !>(|) !>((valid-utf8:lu `@t`0x80c0)))
    (expect-eq !>(|) !>((valid-utf8:lu `@t`0xaf.80e0)))
    (expect-eq !>(|) !>((valid-utf8:lu `@t`0xaf80.80f0)))
    ::  UTF-16 surrogate (U+D800 = 0xed 0xa0 0x80) and above U+10FFFF (0xf4 0x90 0x80 0x80)
    (expect-eq !>(|) !>((valid-utf8:lu `@t`0x80.a0ed)))
    (expect-eq !>(|) !>((valid-utf8:lu `@t`0x8080.90f4)))
    ::  truncated multi-byte sequences
    (expect-eq !>(|) !>((valid-utf8:lu `@t`0xc3)))
    (expect-eq !>(|) !>((valid-utf8:lu `@t`0x80e2)))
    (expect-eq !>(|) !>((valid-utf8:lu `@t`0x98.9ff0)))
  ==
--
