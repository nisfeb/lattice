::  tests for lib/lattice-cashu (from furum): the ecash protocol a mint must agree with, checked
::  against the NUT specs' own vectors and field names
::
/+  *test, ca=lattice-cashu
|%
++  j  |=(t=@t (need (de:json:html t)))
::
::  our secrets map to the curve points a mint computes (NUT-00 vectors 2
::  and 3; vector 1's all-zero message is no atom). a mismatch fails every
::  payment, and a byte-order bug once did
::
++  test-hash-to-curve
  ;:  weld
    %+  expect-eq
      !>('022e7158e11c9506f1aa4248bf531298daa7febd6194f003edcd9b93ade6253acf')
      !>((point-to-hex:ca (hash-to-curve:ca (lsh [3 31] 1))))
    %+  expect-eq
      !>('026cdbe15362df59cd1dd3c9c11de8aedac2106eca69236ecd9fbe117af897be4f')
      !>((point-to-hex:ca (hash-to-curve:ca (lsh [3 31] 2))))
  ==
::
::  a blinded message is NUT-00's for the same secret and blinding factor
::
++  test-blind-message
  =/  blind
    |=  [x=@ r=@]
    (point-to-hex:ca b-prime:(blind-message:ca `@t`(rev 3 32 x) r))
  ;:  weld
    %+  expect-eq
      !>('033b1a9737a40cc3fd9b6af4b723632b76a67a36782596304612a6c2bfb5197e6d')
      !>  %+  blind
            0xd341.ee48.71f1.f889.041e.63cf.0d38.23c7.13ee.a6af.f01e.80f1.719f.08f9.e5be.98f6
          0x99fc.e584.39fc.3741.2ab3.468b.73db.0569.3225.88f6.2fb3.a491.82d6.7e23.d877.824a
    %+  expect-eq
      !>('029bdf2d716ee366eddf599ba252786c1033f47e230248a4612a5670ab931f1763')
      !>  %+  blind
            0xf1aa.f16c.2239.746f.3695.72c0.784d.9dd3.d032.d952.c2d9.9217.5873.fb58.fae3.1a60
          0xf784.76ea.7cc9.ade2.0f9e.05e5.8a80.4cf1.9533.f03e.a805.ece5.fee8.8c8e.2874.ba50
  ==
::
::  point multiplication matches NUT-00's blinded signatures, and
::  unblinding removes exactly the blinding factor: C_ - rK = kY
::
++  test-sign-and-unblind
  =/  k  0x7f7f.7f7f.7f7f.7f7f.7f7f.7f7f.7f7f.7f7f.7f7f.7f7f.7f7f.7f7f.7f7f.7f7f.7f7f.7f7f
  =/  b  (hex-to-point:ca '02a9acc1e48c25eeeb9289b5031cc57da9fe72f3fe2861d264bdc074209b107ba2')
  =/  x  (lsh [3 31] 1)
  =/  r  0x1234.5678.9abc
  =/  b-prime  b-prime:(blind-message:ca `@t`x r)
  ;:  weld
    %+  expect-eq
      !>('0398bc70ce8184d27ba89834d19f5199c84443c31131e48d3c1214db24247d005d')
      !>((point-to-hex:ca (ec-mul:ca b k)))
    %+  expect-eq
      !>((ec-mul:ca (hash-to-curve:ca x) k))
      !>((unblind-signature:ca (ec-mul:ca b-prime k) r (ec-mul:ca secp-g:ca k)))
  ==
::
::  a mint's hex points parse whichever parity prefix they carry (half are
::  03) and in either case, and print back as the mint wrote them
::
++  test-point-hex
  =/  odd  '0398bc70ce8184d27ba89834d19f5199c84443c31131e48d3c1214db24247d005d'
  =/  even  '02a9acc1e48c25eeeb9289b5031cc57da9fe72f3fe2861d264bdc074209b107ba2'
  ;:  weld
    (expect-eq !>(odd) !>((point-to-hex:ca (hex-to-point:ca odd))))
    (expect-eq !>(even) !>((point-to-hex:ca (hex-to-point:ca even))))
    %+  expect-eq  !>((hex-to-point:ca even))
      !>((hex-to-point:ca (crip (cuss (trip even)))))
  ==
::
::  the mint's signatures become proofs a mint will honour: each C is the
::  signature with the blinding removed (k*Y for its secret). a signature
::  whose amount has no key is skipped, and a mint answering fewer or more
::  signatures than we sent yields proofs for what matches, not a crash
::
++  test-finalize-proofs
  =/  keys  (my ~[[1 (ec-mul:ca secp-g:ca 3)] [2 (ec-mul:ca secp-g:ca 5)]])
  =/  sign
    |=  [amt=@ud k=@ secret=@t r=@]
    ^-  [sig=[@ud @t @t] r=@ proof=[amount=@ud id=@t secret=@t c=@t]]
    =/  bm  (blind-message:ca secret r)
    :+  [amt '00ab' (point-to-hex:ca (ec-mul:ca b-prime.bm k))]
      blinding-factor.bm
    [amt '00ab' secret (point-to-hex:ca (ec-mul:ca (hash-to-curve:ca secret) k))]
  =/  one  (sign 1 3 's1' 7)
  =/  two  (sign 2 5 's2' 11)
  =/  bad  (sign 4 9 's3' 13)
  ;:  weld
    %+  expect-eq  !>(~[proof.one proof.two])
      !>((finalize-proofs:ca ~[sig.one sig.two] ~['s1' 's2'] ~[r.one r.two] keys))
    %+  expect-eq  !>(~[proof.one])
      !>((finalize-proofs:ca ~[sig.one] ~['s1' 's2'] ~[r.one r.two] keys))
    %+  expect-eq  !>(~[proof.one])
      !>((finalize-proofs:ca ~[sig.one sig.two] ~['s1'] ~[r.one] keys))
    %+  expect-eq  !>(~[proof.two])
      !>((finalize-proofs:ca ~[sig.bad sig.two] ~['s3' 's2'] ~[r.bad r.two] keys))
  ==
::
::  amounts split into distinct powers of two summing to the total: the
::  only denominations a mint signs
::
++  test-split-amount
  =/  split  |=(n=@ud (sort (split-amount:ca n) lth))
  ;:  weld
    (expect-eq !>(~) !>((split 0)))
    (expect-eq !>(~[1]) !>((split 1)))
    (expect-eq !>(~[1 4 8]) !>((split 13)))
    (expect-eq !>(~[64]) !>((split 64)))
    (expect-eq !>(~[4 32 64]) !>((split 100)))
  ==
::
::  a mint's keys, under keysets or bare, parse to amount -> pubkey, the
::  big denominations too (1024 and up were once dropped, losing those
::  proofs); an empty keyset list or a key that isn't an amount is
::  skipped, not a crash
::
++  test-parse-keys
  ;:  weld
    %+  expect-eq  !>(`(my ~[[1 '02aa'] [2 '02bb']]))
      !>((parse-keys:ca (j '{"keysets":[{"id":"00ab","unit":"sat","keys":{"1":"02aa","2":"02bb"}}]}')))
    %+  expect-eq  !>(`(my ~[[4 '02cc'] [1.024 '02cd'] [1.048.576 '02ce']]))
      !>((parse-keys:ca (j '{"keys":{"4":"02cc","1024":"02cd","1048576":"02ce"}}')))
    %+  expect-eq  !>(`(my ~[[8 '02ee']]))
      !>((parse-keys:ca (j '{"keys":{"abc":"02dd","0":"02ff","8":"02ee"}}')))
    (expect-eq !>(~) !>((parse-keys:ca (j '{"keysets":[]}'))))
    (expect-eq !>(~) !>((parse-keys:ca (j '[1]'))))
  ==
::
::  a mint's answers parse by the NUT-03/04/05 field names. a quote with a
::  null expiry reads 0, which the agent takes as no expiry; one without a
::  quote id is refused
::
++  test-mint-responses
  ;:  weld
    %+  expect-eq  !>(~[[2 '009a' '02ab'] [8 '009a' '02cd']])
      !>((parse-swap-response:ca (j '{"signatures":[{"amount":2,"id":"009a","C_":"02ab"},{"amount":8,"id":"009a","C_":"02cd"}]}')))
    %+  expect-eq  !>(`['q1' 'lnbc1' 'UNPAID' 1.701.704.757])
      !>((parse-mint-quote:ca (j '{"quote":"q1","request":"lnbc1","state":"UNPAID","expiry":1701704757}')))
    %+  expect-eq  !>(`['q1' 'lnbc1' 'PAID' 0])
      !>((parse-mint-quote:ca (j '{"quote":"q1","request":"lnbc1","state":"PAID","expiry":null}')))
    (expect-eq !>(~) !>((parse-mint-quote:ca (j '{"request":"lnbc1","state":"PAID","expiry":1}'))))
    %+  expect-eq  !>(`['q2' 100 2])
      !>((parse-melt-quote:ca (j '{"quote":"q2","amount":100,"fee_reserve":2,"state":"UNPAID"}')))
    (expect-eq !>(`['PAID' %.y]) !>((parse-melt-response:ca (j '{"state":"PAID"}'))))
    (expect-eq !>(`['PENDING' %.n]) !>((parse-melt-response:ca (j '{"state":"PENDING"}'))))
  ==
::
::  what we send a mint carries the field names NUT-03/04/05 require
::
++  test-mint-requests
  =/  out  ~[[8 '009a' '02ab']]
  ;:  weld
    %+  expect-eq
      !>((j '{"inputs":[],"outputs":[{"amount":8,"id":"009a","B_":"02ab"}]}'))
      !>((build-swap-request:ca a+~ out))
    %+  expect-eq
      !>((j '{"quote":"q","outputs":[{"amount":8,"id":"009a","B_":"02ab"}]}'))
      !>((build-mint-request:ca 'q' out))
    %+  expect-eq
      !>((j '{"quote":"q","outputs":[],"inputs":[{"amount":8,"id":"009a","secret":"s","C":"02cd"}]}'))
      !>((build-melt-request:ca 'q' ~[[8 '009a' 's' '02cd']] ~))
    %+  expect-eq  !>((j '{"amount":100,"unit":"sat"}'))
      !>((build-mint-quote-request:ca 100 'sat'))
    %+  expect-eq  !>((j '{"request":"lnbc1","unit":"sat"}'))
      !>((build-melt-quote-request:ca 'lnbc1' 'sat'))
  ==
--
