::  Pure helpers for the grubbery-backed knowledge vault (phase-1 stage 0b).
::
::  Deliberately depends on base + clay types ONLY (path, @ta, @da, sets,
::  maps) — no grubbery tarball/nexus types — so the SAME file compiles both
::  in the %lattice desk (where these arms are unit-tested) and synced into
::  grubbery's gub/lib (where the %lattice nexus wraps them). The nexus casts
::  our structural [pax nom] to a real rail:tarball.
::
|%
::  ==  Knowledge types — byte-identical to /sur/lattice's know-* so the marc
::  payload the nexus stores equals what the %lattice agent stores today.
::
+$  know-vector  [model=@t dim=@ud vec=(list @rd)]
+$  know-entry
  $:  body=@t
      updated=@da
      tags=(set @t)
      vector=(unit know-vector)
  ==
::  programmatic knowledge actions (poked at the vault-manager fiber).
::
+$  know-action
  $%  [%save key=@t body=@t]
      [%del key=@t]
      [%restore key=@t]
      [%move from=@t to=@t]
      [%tag key=@t tag=@t]
      [%untag key=@t tag=@t]
      [%reindex ~]
  ::  migration imports (driven by the agent's /know-migrate). Unlike %save,
  ::  these write the entry VERBATIM — preserving its original updated/tags/
  ::  vector — instead of stamping updated=now. %import lands a live entry;
  ::  %import-trashed lands it then soft-deletes (so it sits in trash, body
  ::  recoverable) for entries the agent had already trashed.
      [%import key=@t entry=know-entry]
      [%import-trashed key=@t entry=know-entry]
  ==
::  derived per-entry index row (drives know-list / know-tags / know-explore
::  without reading bodies). bytes = body byte-length. restore is a RESERVED
::  slot for a future revision-restore feature (peek-at the firm cass captured at
::  delete time); the current soft-delete keeps the body grub live in the trash
::  vault and restores it whole, so restore is always ~. Kept in the row shape so
::  adding the feature later doesn't re-key the persisted know-index grub.
::
+$  index-entry  [updated=@da bytes=@ud tags=(set @t) restore=(unit @ud)]
+$  know-index   (map path index-entry)
::  +to-index-entry: project a stored entry onto its index row (restore always ~).
::
++  to-index-entry
  |=  e=know-entry
  ^-  index-entry
  [updated.e (met 3 body.e) tags.e ~]
::  +derive-index: index every live entry. Pure projection of the vault.
::
++  derive-index
  |=  entries=(map path know-entry)
  ^-  know-index
  (~(run by entries) to-index-entry)
::  +merge-save: body for %save. Preserves an existing entry's tags+vector
::  (save edits content only); a brand-new key starts untagged, no vector.
::
++  merge-save
  |=  [old=(unit know-entry) body=@t now=@da]
  ^-  know-entry
  ?~  old  [body now ~ ~]
  u.old(body body, updated now)
::  +add-tag / +del-tag: %tag / %untag — touch only the tag set.
::
++  add-tag
  |=  [e=know-entry tag=@t]
  ^-  know-entry
  e(tags (~(put in tags.e) tag))
++  del-tag
  |=  [e=know-entry tag=@t]
  ^-  know-entry
  e(tags (~(del in tags.e) tag))
::  +vrail: a rail, expressed structurally so this lib stays grubbery-free.
::  Identical shape to rail:tarball ([p=path name=@ta]).
::
+$  vrail  [pax=path nom=@ta]
::  +entry-leaf: the fixed file name under each key-directory that holds a
::  vault entry's content. Reserving one leaf name per key-dir is what lets a
::  flat (map path know-entry) — where /a and /a/b may BOTH be entries — map
::  onto a tree: /a becomes the file [/a %entry] and /a/b the file [/a/b
::  %entry], and the directory /a happily holds both the file `entry` and the
::  child directory `b`.
::
++  entry-leaf  `@ta`%entry
::  +key-to-rail: a know-key (path) -> the vault rail holding its entry,
::  rooted at [base]. Total: every key, including the empty key, maps.
::
++  key-to-rail
  |=  [base=path key=path]
  ^-  vrail
  [(weld base key) entry-leaf]
::  +rail-to-key: inverse of +key-to-rail. ~ if [vrail] is not an entry leaf
::  under [base] (wrong leaf name, or outside the vault subtree).
::
++  rail-to-key
  |=  [base=path =vrail]
  ^-  (unit path)
  ?.  =(nom.vrail entry-leaf)  ~
  =/  bl=@ud  (lent base)
  ?.  =(base (scag bl pax.vrail))  ~
  `(slag bl pax.vrail)
--
