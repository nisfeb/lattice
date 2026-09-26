::  Unit tests for /lib/lattice-know (pure vault helpers).  Run with:
::    -test %/tests/lib/lattice-know ~   (or the run-tests MCP tool)
::
/+  *test, *lattice-know
|%
++  base  `path`/lattice/know/vault
::  Every key maps to [base+key %entry]: the storage layout the vault uses.
::
++  test-key-to-rail
  ;:  weld
    (expect-eq !>(`vrail`[/lattice/know/vault/projects/x %entry]) !>((key-to-rail base /projects/x)))
    ::  empty key -> the `entry` file directly under the vault root
    (expect-eq !>(`vrail`[/lattice/know/vault %entry]) !>((key-to-rail base ~)))
    ::  prefix coexistence: /a and /a/b are distinct leaves, neither inside
    ::  the other's entry
    (expect-eq !>(`vrail`[/lattice/know/vault/a %entry]) !>((key-to-rail base /a)))
    (expect-eq !>(`vrail`[/lattice/know/vault/a/b %entry]) !>((key-to-rail base /a/b)))
  ==
::  sample entries for derivation tests.
::
++  e1  ^-  know-entry  ['hello' ~2026.1.1 (sy ~['ai' 'notes']) ~]
++  e2  ^-  know-entry  ['hi' ~2026.2.2 ~ ~]
::  +to-index-entry drops the body, keeping updated/bytes/tags; bytes = (met 3).
::
++  test-to-index-entry
  ;:  weld
    (expect-eq !>(`index-entry`[~2026.1.1 5 (sy ~['ai' 'notes']) ~]) !>((to-index-entry e1)))
    (expect-eq !>(`index-entry`[~2026.2.2 2 ~ ~]) !>((to-index-entry e2)))
  ==
::  +merge-save: new key -> [body now ~ ~]; existing -> keep tags+vector,
::  bump body+updated.
::
++  test-merge-save
  ;:  weld
    (expect-eq !>(`know-entry`['new' ~2026.3.3 ~ ~]) !>((merge-save ~ 'new' ~2026.3.3)))
    %+  expect-eq
      !>(`know-entry`['edit' ~2026.3.3 (sy ~['ai' 'notes']) ~])
    !>((merge-save `e1 'edit' ~2026.3.3))
  ==
::  +add-tag / +del-tag: only the tag set changes; idempotent.
::
++  test-tagging
  ;:  weld
    (expect-eq !>(`know-entry`['hi' ~2026.2.2 (sy ~['x']) ~]) !>((add-tag e2 'x')))
    ::  adding an existing tag is a no-op
    (expect-eq !>(e1) !>((add-tag e1 'ai')))
    (expect-eq !>(`know-entry`['hello' ~2026.1.1 (sy ~['notes']) ~]) !>((del-tag e1 'ai')))
    ::  deleting an absent tag is a no-op
    (expect-eq !>(e2) !>((del-tag e2 'nope')))
  ==
--
