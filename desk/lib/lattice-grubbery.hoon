::  /lib/lattice-grubbery: the grubbery-vault adapter (phase-1 stage 1a).
::
::  DEAD CODE until know-where flips to %grubbery at cutover (stage 1b). These
::  arms let the %lattice agent read/write its private knowledge through the
::  grubbery %lattice nexus instead of the in-state know/trash maps:
::    - reads  : %gx scry of grubbery's on-peek namespace. NB: +mule does NOT
::               catch .^ faults (grubbery's own lib/nexus notes a "scry-free
::               mule" for this), and reading a MISSING grub faults — so callers
::               MUST gate +read-entry on the always-present index (+read-index),
::               never read a grub blind.
::    - writes : a %grubbery-load poke carrying a %poke dart aimed at the nexus
::               writer (main.sig). The owner's dart has full access (no weir).
::    - probe  : %gu presence check (fault-free, unlike %gx on absence) so
::               callers can answer 503 when grubbery is not installed.
::
::  COUPLING: the write poke's payload must nest under grubbery's
::  +load:remo:nexus (see grubbery lib/nexus.hoon ~line 1064) so grubbery's
::  on-poke can !< it. Rather than import grubbery's libs into this desk, we
::  mirror ONLY the %poke variant + the rail/lane/bask shapes it needs
::  (+gload below). If grubbery's load type changes shape, this mirror must
::  follow — ponytail: the alternative is vendoring lib/nexus + lib/tarball,
::  which drags in the whole loader/axal stack for one poke.
::
/-  *lattice
|%
::  ── grubbery tarball-shape mirrors (write path only) ──
::  rail = [path name]; lane = file-or-dir; blot = a mark identity (a rail);
::  bask = blot-typed noun. Byte-identical to grubbery's tarball.hoon.
+$  grail  [=path name=@ta]
+$  glane  (each grail path)
+$  gbask  (pair grail *)
::  the subset of +load:remo:nexus we emit: a single %poke dart. Nests under
::  the full 8-variant union on grubbery's side.
+$  gload  [[=wire dest=glane] [%poke =gbask]]
::  the nexus index grub's value shape (lattice-know +know-index): key -> meta,
::  no bodies. Mirrored so we can read the full vault key set in ONE always-
::  present scry — reading a MISSING grub directly faults .^ (and +mule does NOT
::  catch .^ faults), so callers must check the index before +read-entry.
+$  gindex  (map path [updated=@da bytes=@ud tags=(set @t) restore=(unit @ud)])
::  ── nexus location ──
::  where the %lattice nexus lives inside grubbery's tree (its raw born path;
::  the neck-remapped HTTP form is apps/lattice.lattice_app, same path).
++  nexus-app  `path`/apps/'lattice.lattice_app'
::  +vault-path: the grubbery tree path of a know-key's entry grub. key is an
::  already-parsed know-key (path). /a -> .../know/vault/a/entry.
++  vault-path
  |=  key=path
  ^-  path
  :(weld nexus-app /know/vault key /entry)
::  +index-path / +trash-path: the nexus derived-index grubs (key -> meta).
++  index-path  ^-(path (weld nexus-app /know/index))
++  trash-path  ^-(path (weld nexus-app /know/trash))
::  +scry-base: /[our]/grubbery/[now] prefix for a %gx peek into grubbery.
++  scry-base
  |=  [our=@p now=@da]
  ^-  path
  /(scot %p our)/grubbery/(scot %da now)
::  ── presence probe ──
::  +installed: is %grubbery running? %gu = "is the agent running"; the spur must
::  be /$ (see sys/vane/eyre's rof ... %gu [our app da+now] /$). %gu answers
::  cleanly for a missing agent (%.n, no fault) — unlike a %gx read, which would
::  fault uncatchably — so it's the safe 503 gate every grubbery path checks.
::  ponytail: the %.n (grubbery-absent) branch is unexercised in test; if it ever
::  faults instead of answering, an owner endpoint 500s instead of 503 — harmless
::  (owner-only, grubbery is present whenever the flag is %grubbery).
++  installed
  |=  [our=@p now=@da]
  ^-  ?
  .^(? %gu /(scot %p our)/grubbery/(scot %da now)/$)
::  ── reads ──
::  +read-entry: scry one vault entry by key. ~ if absent, tombstoned, or
::  grubbery is down/younger. The stored grub's mark (know-entry) carries the
::  SAME shape as our know-entry, so the molded read is exact.
++  read-entry
  |=  [our=@p now=@da key=path]
  ^-  (unit know-entry)
  =/  res
    %-  mule
    |.  ^-  know-entry
    .^(know-entry %gx :(weld (scry-base our now) /peek/file (vault-path key) /know-entry))
  ?:(?=(%& -.res) `p.res ~)
::  +read-index / +read-trash: the nexus live/trash index (key -> meta). Always
::  present once the nexus exists, so the scry doesn't fault — this is the safe
::  way to learn the vault's key set without reading (maybe-missing) grubs.
::  Requests the grub's own mark (know-index) so gall returns it without a
::  desk-mark conversion (the marc lives in grubbery's gub, not /mar).
++  read-index
  |=  [our=@p now=@da]
  ^-  gindex
  =/  res
    %-  mule
    |.  ^-  gindex
    .^(gindex %gx :(weld (scry-base our now) /peek/file index-path /know-index))
  ?:(?=(%& -.res) p.res ~)
++  read-trash
  |=  [our=@p now=@da]
  ^-  gindex
  =/  res
    %-  mule
    |.  ^-  gindex
    .^(gindex %gx :(weld (scry-base our now) /peek/file trash-path /know-index))
  ?:(?=(%& -.res) p.res ~)
::  ── writes ──
::  +poke-cage: the [mark vase] to %poke at %grubbery to drive one know-action
::  through the nexus writer. dest is the nexus main.sig; blot /lattice
::  know-action selects the writer's grab. wire labels the dart for the ack.
++  poke-cage
  |=  [=wire act=know-action]
  ^-  cage
  (action-cage wire act)
::  +import-cage: a migration poke — write an entry VERBATIM (preserving its
::  updated/tags/vector) into the vault, live or trashed. The nexus's know-action
::  carries these import variants; we send the matching noun (the agent's
::  know-action union doesn't include them, so build it structurally here).
+$  gimport
  $%  [%import key=@t entry=know-entry]
      [%import-trashed key=@t entry=know-entry]
  ==
++  import-cage
  |=  [=wire imp=gimport]
  ^-  cage
  (action-cage wire imp)
::  +action-cage: build the [mark vase] to %poke at %grubbery driving one action
::  (know-action OR an import) through the nexus writer. dest = the nexus
::  main.sig; blot /lattice/know-action selects the writer's grab.
++  action-cage
  |=  [=wire act=*]
  ^-  cage
  =/  =gload
    :-  [wire [%& [nexus-app %'main.sig']]]
    [%poke [[/lattice %know-action] act]]
  [%grubbery-load !>(gload)]
--
