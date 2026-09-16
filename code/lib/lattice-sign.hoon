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
+$  signed
  $:  =ship
      life=@ud
      digest=@
      sig=@ux
  ==
::
::  +record: build the signed record for `content`.
::
++  record
  |=  [=ship life=@ud =ring content=@]
  ^-  signed
  =/  d=@  (digest content)
  [ship life d (sign-with ring d)]
::
::  fake ships: jael derives every keypair from the @p, so on a fake ship
::  any ship's keys are computable. This mirrors the fake branch of the
::  %deed scry in sys/vane/jael.hoon, and it is what lets the arms above
::  be unit-tested with no network and no real key.
::
++  fake-core  |=(who=ship (pit:nu:cric:crypto 512 who %b ~))
++  fake-ring  |=(who=ship `ring`sec:ex:(fake-core who))
++  fake-pass  |=(who=ship `pass`pub:ex:(fake-core who))
--
