::  Unit tests for /lib/lattice-know (pure vault helpers).  Run with:
::    -test %/tests/lib/lattice-know ~   (or the run-tests MCP tool)
::
/+  *test, *lattice-know
|%
++  base  `path`/lattice/know/vault
::  Every key maps to [base+key %entry], and round-trips back.
::
++  test-key-to-rail
  ;:  weld
    (expect-eq !>(`vrail`[/lattice/know/vault/projects/x %entry]) !>((key-to-rail base /projects/x)))
    ::  empty key -> the `entry` file directly under the vault root
    (expect-eq !>(`vrail`[/lattice/know/vault %entry]) !>((key-to-rail base ~)))
  ==
::
++  test-rail-key-roundtrip
  ;:  weld
    (expect-eq !>(`(unit path)`[~ /projects/x]) !>((rail-to-key base (key-to-rail base /projects/x))))
    ::  prefix coexistence: /a and /a/b both round-trip distinctly
    (expect-eq !>(`(unit path)`[~ /a]) !>((rail-to-key base (key-to-rail base /a))))
    (expect-eq !>(`(unit path)`[~ /a/b]) !>((rail-to-key base (key-to-rail base /a/b))))
    ::  empty key round-trips to the empty path
    (expect-eq !>(`(unit path)`[~ ~]) !>((rail-to-key base (key-to-rail base ~))))
  ==
::
++  test-rail-to-key-rejects-foreign
  ;:  weld
    ::  wrong leaf name (an index grub, not an entry)
    (expect-eq !>(`(unit path)`~) !>((rail-to-key base [/lattice/know/vault/a %index])))
    ::  outside the vault subtree
    (expect-eq !>(`(unit path)`~) !>((rail-to-key base [/lattice/pub/a %entry])))
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
::  +derive-index projects every entry, keyed identically.
::
++  test-derive-index
  =/  in=(map path know-entry)  (my /a^e1 /b/c^e2 ~)
  =/  want=know-index  (my /a^[~2026.1.1 5 (sy ~['ai' 'notes']) ~] /b/c^[~2026.2.2 2 ~ ~] ~)
  (expect-eq !>(want) !>((derive-index in)))
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
