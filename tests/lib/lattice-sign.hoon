::  Unit tests for /lib/lattice-sign.
::
::    Every test here runs on the fake-ship key derivation: jael derives
::    each keypair from the @p, so any ship's keys are computable with no
::    network and no second ship. That is the same trick auspex's tests
::    use, and it is why signing can be tested at all without a real key.
::
::    The salt is the load-bearing assertion in this file. Auspex salts
::    its digest %auspex so its signatures cannot be replayed as ames
::    packets or attestations; lattice signs with the SAME key, so a
::    lattice signature must not be replayable as an auspex message
::    either. +test-digest-is-domain-separated is that guarantee.
::
/+  *test, ls=lattice-sign
|%
++  who  ~sampel-palnet
++  other  ~palnet-sampel
::
::  fake ships: jael derives every keypair from the @p, so on a fake ship
::  any ship's keys are computable. This mirrors the fake branch of the
::  %deed scry in sys/vane/jael.hoon, and it is what lets sign and verify
::  be tested with no network and no real key. (It lived in the lib, where
::  nothing but these tests used it.)
::
++  fake-core  |=(who=ship (pit:nu:cric:crypto 512 who %b ~))
++  fake-ring  |=(who=ship `ring`sec:ex:(fake-core who))
++  fake-pass  |=(who=ship `pass`pub:ex:(fake-core who))
::
::  ==  digest
::
++  test-digest-is-salted-sham
  ;:  weld
    (expect-eq !>((shaf %lattice (sham 'hello'))) !>((digest:ls 'hello')))
    ::  and of nothing: signing nothing is the caller's decision
    (expect-eq !>((shaf %lattice (sham ''))) !>((digest:ls '')))
  ==
::
::  domain separation: the whole point of the salt. A lattice digest must
::  differ from the unsalted hash, from auspex's, and from ames'.
++  test-digest-is-domain-separated
  ;:  weld
    (expect !>(!=((digest:ls 'hello') (sham 'hello'))))
    (expect !>(!=((digest:ls 'hello') (shaf %auspex (sham 'hello')))))
    (expect !>(!=((digest:ls 'hello') (shaf %ames (sham 'hello')))))
  ==
::
++  test-digest-covers-content
  (expect !>(!=((digest:ls 'a') (digest:ls 'b'))))
::
::
::  ==  sign / verify round trip
::
++  test-sign-verifies-with-own-key
  =/  d    (digest:ls 'a document')
  =/  sig  (sign-with:ls (fake-ring who) d)
  (expect !>((verify-with:ls (fake-pass who) sig d)))
::
::  a signature made by one ship must NOT verify against another's key.
++  test-sign-fails-under-wrong-key
  =/  d    (digest:ls 'a document')
  =/  sig  (sign-with:ls (fake-ring who) d)
  (expect !>(!(verify-with:ls (fake-pass other) sig d)))
::
::  tamper: the signature is over the digest, so changing the content
::  changes the digest and the check fails.
++  test-tampered-content-fails
  =/  sig  (sign-with:ls (fake-ring who) (digest:ls 'original'))
  (expect !>(!(verify-with:ls (fake-pass who) sig (digest:ls 'tampered'))))
::
::  a garbage signature against a good digest fails rather than crashing.
++  test-garbage-signature-fails
  =/  d  (digest:ls 'a document')
  (expect !>(!(verify-with:ls (fake-pass who) 0xdead.beef d)))
::
::  THE REPLAY GUARANTEE, stated as a test: a signature made over an
::  auspex-salted digest must not verify as a lattice one, and vice
::  versa, even though the same key made both.
++  test-cannot-replay-across-salts
  =/  auspex-d  (shaf %auspex (sham 'hello'))
  =/  sig       (sign-with:ls (fake-ring who) auspex-d)
  (expect !>(!(verify-with:ls (fake-pass who) sig (digest:ls 'hello'))))
::
::  ==  the signed record the endpoint returns
::
::  +record is what /sign answers and what /verify consumes. It carries
::  life because a signature must outlive key rotation: a record made
::  under life 3 stays checkable after the ship rotates to life 4.
++  test-record-carries-signer-and-life
  =/  r  (record:ls who 3 (fake-ring who) 'content')
  ;:  weld
    (expect-eq !>(who) !>(ship.r))
    (expect-eq !>(`@ud`3) !>(life.r))
    (expect-eq !>((digest:ls 'content')) !>(digest.r))
  ==
::
++  test-record-verifies
  =/  r  (record:ls who 1 (fake-ring who) 'content')
  (expect !>((verify-with:ls (fake-pass who) sig.r digest.r)))
--
