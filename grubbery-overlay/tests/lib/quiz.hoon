::  Smoke test for the vendored /lib/quiz.
::
::  Upstream is pinned to [%zuse 413] and this desk is on 408, so before any
::  property test is worth writing, four things have to be true here:
::  a true law is heeded, a false law is refuted, a CRASH is refuted (rather
::  than taking the test runner down with it), and a caller-supplied norn is
::  actually used. If this file is red, every *-prop file below it is noise.
::
::  Run: mcp/run-tests {desk:grubbery, path:/tests/lib/quiz}
::
/+  *test, quiz=lattice-quiz
|%
::  Fixed entropy: %quiz reports are only useful if a failure reproduces, and a
::  bare `check.quiz` seeds from 0 with 100 runs. Both are pinned here.
++  chk  ~(check quiz `@uv`0xca55.e77e 64)
::
::  A law that holds: addition commutes over generated atoms.
++  test-quiz-heeds-a-true-law
  =/  fate=vase  !>(|=([a=@ b=@] ^-(? =((add a b) (add b a)))))
  (expect !>((chk fate ~ ~)))
::
::  A law that does not hold: two independently generated atoms are equal.
::  %quiz must return | here. If this passes, the runner is not running.
++  test-quiz-refutes-a-false-law
  =/  fate=vase  !>(|=([a=@ b=@] ^-(? =(a b))))
  (expect-eq !>(|) !>((chk fate ~ ~)))
::
::  THE arm that makes %quiz worth vendoring: the fate CRASHES (+dec on 0) and
::  the check reports a refutation instead of bailing. That is +mong doing its
::  job, and it is the only way an in-ship test can assert "never crashes".
++  test-quiz-catches-a-crash
  =/  fate=vase  !>(|=(a=@ ^-(? =(0 (dec a)))))
  (expect-eq !>(|) !>((chk fate ~ ~)))
::
::  A caller-supplied norn is used in place of the type-driven filler. The norn
::  only ever yields 7, so the law "the sample is 7" must hold, and the law
::  "the sample is 8" must not. Both directions, or a norn that is silently
::  ignored would still pass the first.
++  test-quiz-uses-a-supplied-norn
  =/  give  |=([size=@ud rng=_og] ^-(@ 7))
  ;:  weld
    (expect !>((chk !>(|=(a=@ ^-(? =(7 a)))) `give ~)))
    (expect-eq !>(|) !>((chk !>(|=(a=@ ^-(? =(8 a)))) `give ~)))
  ==
::
::  %drop reports uninteresting samples without failing the check.
++  test-quiz-drops
  =/  fate=vase  !>(|=([a=@ b=@] ^-($?(%drop ?) ?:((lth b a) %drop =(b (add (sub b a) a))))))
  (expect !>((chk fate ~ ~)))
--
