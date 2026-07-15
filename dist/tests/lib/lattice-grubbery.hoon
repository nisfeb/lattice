::  tests for /lib/lattice-grubbery: the pure builders of the grubbery adapter
::  (path + poke construction). The scry helpers (installed/read-entry) hit .^
::  and need a live ship, so they're covered by on-ship integration, not here.
::
/-  *lattice
/+  *lattice-grubbery
/+  *test
|%
::  +vault-path: a know-key maps to its entry grub under the nexus vault, with
::  the fixed `entry` leaf so /a and /a/b can coexist.
++  test-vault-path
  ;:  weld
    %+  expect-eq
      !>  `path`/apps/'lattice.lattice_app'/know/vault/a/entry
      !>  (vault-path /a)
    %+  expect-eq
      !>  `path`/apps/'lattice.lattice_app'/know/vault/a/b/entry
      !>  (vault-path /a/b)
  ==
::  +scry-base: the /[our]/grubbery/[now] %gx prefix.
++  test-scry-base
  %+  expect-eq
    !>  `path`/(scot %p ~zod)/grubbery/(scot %da ~2026.1.1)
    !>  (scry-base ~zod ~2026.1.1)
::  +poke-cage: a %grubbery-load poke whose dart is a %poke at the nexus
::  main.sig, blot /lattice/know-action, carrying the action verbatim.
++  test-poke-cage
  =/  act=know-action  [%save '/a' 'hi']
  =/  cg=cage  (poke-cage /lat-write act)
  =/  got=gload  !<(gload q.cg)
  =/  want=gload
    :-  [/lat-write [%& [/apps/'lattice.lattice_app' %'main.sig']]]
    [%poke [[/lattice %know-action] act]]
  ;:  weld
    (expect-eq !>(%grubbery-load) !>(p.cg))
    (expect-eq !>(want) !>(got))
  ==
::  +pub-vault-path: a content-map key maps to its page grub under the /pub vault,
::  the leading `pub` stripped and the key's tail as the grub leaf.
++  test-pub-vault-path
  ;:  weld
    %+  expect-eq
      !>  `path`/apps/'lattice.lattice_app'/pub/vault/notes/intro/gmi
      !>  (pub-vault-path /pub/notes/intro/gmi)
    ::  the home page
    %+  expect-eq
      !>  `path`/apps/'lattice.lattice_app'/pub/vault/index/gmi
      !>  (pub-vault-path /pub/index/gmi)
  ==
::  +page-action-cage: a %grubbery-load poke whose dart is a %poke at the nexus
::  main.sig, blot /lattice/pub-action, carrying the pub-action noun verbatim.
++  test-page-action-cage
  =/  act  [%save-page '/pub/a/gmi' 'hi']
  =/  cg=cage  (page-action-cage /lat-pub-write act)
  =/  got=gload  !<(gload q.cg)
  =/  want=gload
    :-  [/lat-pub-write [%& [/apps/'lattice.lattice_app' %'main.sig']]]
    [%poke [[/lattice %pub-action] act]]
  ;:  weld
    (expect-eq !>(%grubbery-load) !>(p.cg))
    (expect-eq !>(want) !>(got))
  ==
--
