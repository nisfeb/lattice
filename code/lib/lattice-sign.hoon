::  Sign arbitrary content with this ship's key, and check such signatures.
::
::    Deliberately depends on base + zuse types ONLY (ring, pass, @ux, @),
::    no grubbery tarball/nexus types, so the SAME file compiles both in a
::    plain desk /lib (where these arms are unit-tested) and in grubbery's
::    gub/lib (where the lattice nexus wraps them). The nexus supplies the
::    ring and life it scried from jael; nothing here reaches the network,
::    the namespace, or the clock.
::
::    THE SALT IS LOAD-BEARING. One ship key signs several different
::    things: ames packets, azimuth attestations, and — on a ship running
::    both apps — auspex mail. Each salts its preimage so a signature made
::    for one can never be presented as a signature for another. Lattice
::    salts %lattice for exactly that reason, and
::    +test-cannot-replay-across-salts pins it: a signature over an
::    auspex-salted digest does not verify as a lattice one, though the
::    same key made it.
::
|%
::  +digest: the preimage every lattice signature covers.
::
::    Hash first, then sign the hash. Signing the content directly would
::    put an unbounded caller-supplied atom into the signature input; a
::    fixed-width salted hash keeps the signed value one size whatever
::    was submitted, which is what makes signing a large file the same
::    operation as signing a word.
::
++  digest
  |=  content=@
  ^-  @
  (shaf %lattice (sham content))
::
::  +digest-2: the preimage of a version 2 record, which /sign makes now.
::
::    Full width: salted SHA-256 over the content's byte length and its
::    bytes, jammed together. Version 1 (+digest) is a 128-bit fold of a
::    128-bit sham, so two documents with one digest cost about 2^64
::    trials to find, and an owner who signed one had signed both
::    (security audit run-1). The length binds trailing NUL bytes, which
::    an atom alone does not hold. +digest stays, to check old records.
::
++  digest-2
  |=  [len=@ud content=@]
  ^-  @
  (shas %lattice-2 (jam [len content]))
::
::  +digest-of: the digest a record of version `v` covers.
::
++  digest-of
  |=  [v=@ud len=@ud content=@]
  ^-  @
  ?:(=(2 v) (digest-2 len content) (digest content))
::
::  +sign-with: sign a digest with a ring. The ring never leaves the
::  caller; nothing here stores or logs it.
::
++  sign-with
  |=  [=ring msg=@]
  ^-  @ux
  (sigh:as:(nol:nu:cric:crypto ring) msg)
::
::  +verify-with: does `sig` cover `msg` under `pass`?
::
::    Answers a loobean, never crashes: a malformed signature is a %.n,
::    because this runs on caller-supplied input at an HTTP boundary.
::
++  verify-with
  |=  [=pass sig=@ux msg=@]
  ^-  ?
  (safe:as:(com:nu:cric:crypto pass) sig msg)
::
::  +signed: what /sign answers and what /verify consumes.
::
::    `life` travels with the signature because signatures must outlive
::    key rotation: a record made under life 3 stays verifiable after the
::    ship rotates to life 4, and a verifier needs to know which key to
::    look up. `digest` travels so a verifier never re-derives it — and
::    so a verifier that DOES re-derive it can catch a record whose
::    stated digest disagrees with its stated content.
::
::    `v` is the digest construction: 2 for +digest-2, 1 for a record
::    made before it (+digest), which carried no version.
::
+$  signed
  $:  =ship
      life=@ud
      v=@ud
      digest=@
      sig=@ux
  ==
::
::  +record: build the signed record for `len` bytes of `content`.
::
++  record
  |=  [=ship life=@ud =ring len=@ud content=@]
  ^-  signed
  =/  d=@  (digest-2 len content)
  [ship life 2 d (sign-with ring d)]
--
