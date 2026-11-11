::  lib/lattice-cashu.hoon: Cashu wallet operations (NUT-00/02/03/04/05/07/08/09), from furum
::
::  Standard-compliant BDHKE using zuse's jetted secp256k1 operations.
::  Implements hash-to-curve, blinding, unblinding per NUT-00 spec.
::
|%
::  secp256k1 field prime
++  secp-p
  0xffff.ffff.ffff.ffff.ffff.ffff.ffff.ffff.
  ffff.ffff.ffff.ffff.ffff.fffe.ffff.fc2f
::  secp256k1 curve order
++  secp-n
  0xffff.ffff.ffff.ffff.ffff.ffff.ffff.fffe.
  baae.dce6.af48.a03b.bfd2.5e8c.d036.4141
::  secp256k1 generator point
++  secp-g
  ^-  [x=@ y=@]
  :*  x=0x79be.667e.f9dc.bbac.55a0.6295.ce87.0b07.
        029b.fcdb.2dce.28d9.59f2.815b.16f8.1798
      y=0x483a.da77.26a3.c465.5da4.fbfc.0e11.08a8.
        fd17.b448.a685.5419.9c47.d08f.fb10.d4b8
  ==
::
::  -- Hex helpers --
::
++  hex-to-bytes
  |=  hex=@t
  ^-  @
  %+  roll  (trip hex)
  |=  [c=@ acc=@]
  =/  nib
    ?:  &((gte c '0') (lte c '9'))  (sub c '0')
    ?:  &((gte c 'a') (lte c 'f'))  (add 10 (sub c 'a'))
    ?:  &((gte c 'A') (lte c 'F'))  (add 10 (sub c 'A'))
    ~|(%bad-hex-char !!)
  (add (mul acc 16) nib)
::
++  bytes-to-hex
  |=  [val=@ width=@ud]
  ^-  @t
  =/  hex-chars=tape  "0123456789abcdef"
  =/  out=tape
    =/  idx=@ud  0
    =/  acc=tape  ~
    |-  ^-  tape
    ?:  =(idx width)  acc
    =/  byte  (cut 3 [(sub (dec width) idx) 1] val)
    =/  hi  (snag (div byte 16) hex-chars)
    =/  lo  (snag (mod byte 16) hex-chars)
    $(idx +(idx), acc (snoc (snoc acc hi) lo))
  (crip out)
::
::  -- Point decompression (pure Hoon, replaces zuse) --
::
::  Decompress a 33-byte compressed secp256k1 point to affine [x y]
++  ec-decompress
  |=  compressed=@
  ^-  [x=@ y=@]
  =/  prefix=@  (cut 3 [32 1] compressed)
  ?>  |(=(2 prefix) =(3 prefix))
  =/  x=@  (end [3 32] compressed)
  =/  fop  ~(. fo secp-p)
  =/  x3  (pro:fop x (pro:fop x x))
  =/  y2  (sum:fop x3 7)
  ::  y = y2^((p+1)/4) mod p  (works since p ≡ 3 mod 4)
  =/  y=@  (~(exp fo secp-p) (div (add secp-p 1) 4) y2)
  ::  verify y^2 == y2
  ?>  =((pro:fop y y) y2)
  ::  adjust parity to match prefix
  =/  need-odd=?  =(3 prefix)
  =?  y  !=(=(1 (mod y 2)) need-odd)
    (sub secp-p y)
  [x y]
::
::  -- Point serialization --
::
::  Parse compressed hex point ("02abc..." / "03abc...", 66 chars) to point
++  hex-to-point
  |=  hex=@t
  ^-  [x=@ y=@]
  =/  chars=tape  (trip hex)
  ?>  =(66 (lent chars))
  =/  prefix=@t  (crip (scag 2 chars))
  ?>  |(=(prefix '02') =(prefix '03'))
  =/  compressed=@  (hex-to-bytes hex)
  (ec-decompress compressed)
::
::  Compress point to hex string
++  point-to-hex
  |=  pt=[x=@ y=@]
  ^-  @t
  ::  manual compression: 02 if y even, 03 if y odd, then x big-endian
  =/  prefix=@  ?:(=(0 (mod y.pt 2)) 2 3)
  =/  compressed=@  (add (lsh [3 32] prefix) x.pt)
  (bytes-to-hex compressed 33)
::
::  -- Hash-to-curve (NUT-00 spec) --
::
::  Domain separator per Cashu NUT-00
++  domain-separator  'Secp256k1_HashToCurve_Cashu_'
::
++  hash-to-curve
  |=  message=@
  ^-  [x=@ y=@]
  =/  domain=@  domain-separator
  =/  domain-len=@ud  (met 3 domain)
  =/  msg-len=@ud  (met 3 message)
  =/  msg-hash=@  (shay (add domain-len msg-len) (cat 3 domain message))
  =/  counter=@ud  0
  |-
  ?>  (lth counter 65.536)
  ::  SHA-256(msg_hash || counter_le32)
  ::  counter as 4-byte LE is just the atom value; shay reads 36 bytes
  =/  hash=@  (rev 3 32 (shay 36 (cat 3 msg-hash counter)))
  ::  try to decompress as 02 || hash (even-y point)
  =/  compressed=@  (add (lsh [3 32] 2) hash)
  =/  result  (mule |.((ec-decompress compressed)))
  ?:  ?=([%& *] result)
    p.result
  $(counter +(counter))
::
::  -- Elliptic curve point addition (affine, secp256k1) --
::
::  Uses Hoon stdlib fo core for modular field arithmetic.
::  Replaces zuse add-points which produces invalid results.
::
++  ec-add
  |=  [p1=[x=@ y=@] p2=[x=@ y=@]]
  ^-  [x=@ y=@]
  =/  fop  ~(. fo secp-p)
  ?:  &(=(x.p1 x.p2) =(y.p1 y.p2))
    ::  point doubling: lam = 3*x1^2 / (2*y1)
    =/  lam  (fra:fop (pro:fop 3 (pro:fop x.p1 x.p1)) (pro:fop 2 y.p1))
    =/  x3  (dif:fop (dif:fop (pro:fop lam lam) x.p1) x.p2)
    =/  y3  (dif:fop (pro:fop lam (dif:fop x.p1 x3)) y.p1)
    [x3 y3]
  ::  point addition: lam = (y2 - y1) / (x2 - x1)
  =/  lam  (fra:fop (dif:fop y.p2 y.p1) (dif:fop x.p2 x.p1))
  =/  x3  (dif:fop (dif:fop (pro:fop lam lam) x.p1) x.p2)
  =/  y3  (dif:fop (pro:fop lam (dif:fop x.p1 x3)) y.p1)
  [x3 y3]
::
::  Scalar multiplication: zuse's, in jacobian coordinates, with one
::  inverse at the end. An affine double-and-add here took 2.5 s a
::  multiply on a fake ship, zuse's 0.1 s, and every output a payment
::  blinds or unblinds takes one.
::
++  ec-mul
  |=  [pt=[x=@ y=@] k=@]
  ^-  [x=@ y=@]
  (mul-point-scalar:secp256k1:secp:crypto pt k)
::
::  -- BDHKE operations --
::
::  Blind a message for signing: B_ = Y + r*G
::  Returns [B_ r] where r is the blinding factor
++  blind-message
  |=  [secret=@t r=@]
  ^-  [b-prime=[x=@ y=@] blinding-factor=@]
  ::  reduce r modulo curve order to ensure valid scalar
  =/  r-mod=@  (mod r secp-n)
  =?  r-mod  =(0 r-mod)  1
  =/  yy  (hash-to-curve secret)
  =/  r-g  (ec-mul secp-g r-mod)
  =/  b-prime  (ec-add yy r-g)
  [b-prime=b-prime blinding-factor=r-mod]
::
::  Unblind a signature: C = C_ - r*K
::  C_ = blinded signature from mint
::  r  = blinding factor used during blinding
::  K  = mint's public key for this denomination
++  unblind-signature
  |=  [c-blind=[x=@ y=@] r=@ mint-key=[x=@ y=@]]
  ^-  [x=@ y=@]
  =/  r-k  (ec-mul mint-key r)
  ::  negate r*K: flip y coordinate (mod p)
  =/  neg-r-k  r-k(y (sub secp-p y.r-k))
  =/  result  (ec-add c-blind neg-r-k)
  result
::
::  -- NUT-03 swap request/response builders --
::
::  Build a single blinded output for swap
::  Returns [B_hex secret blinding-factor]
++  make-output
  |=  [amount=@ud keyset-id=@t eny=@]
  ^-  [b-hex=@t secret=@t blinding-factor=@]
  ::  generate random secret (32 bytes hex)
  =/  secret=@t  (bytes-to-hex (shax eny) 32)
  ::  use hash of eny as blinding factor (ensure non-zero, < curve order)
  =/  r=@  (shax (cat 3 eny 'blind'))
  =/  [b-prime=[x=@ y=@] blinding-factor=@]  (blind-message secret r)
  ::  verify the point is valid by round-trip: compress then decompress
  =/  b-hex=@t  (point-to-hex b-prime)
  =/  check  (mule |.((hex-to-point b-hex)))
  ?.  ?=([%& *] check)
    ::  point invalid, retry with different entropy
    $(eny (shax (cat 3 eny 'retry')))
  [b-hex secret blinding-factor]
::
::  Build swap request JSON from user proofs and generated outputs
++  build-swap-request
  |=  [inputs=json outputs=(list [amount=@ud id=@t b-hex=@t])]
  ^-  json
  (pairs:enjs:format ~[['inputs' inputs] ['outputs' (outputs-json outputs)]])
::
++  outputs-json
  |=  outputs=(list [amount=@ud id=@t b-hex=@t])
  ^-  json
  :-  %a
  %+  turn  outputs
  |=  [amount=@ud id=@t b-hex=@t]
  %-  pairs:enjs:format
  :~  ['amount' (numb:enjs:format amount)]
      ['id' s+id]
      ['B_' s+b-hex]
  ==
::
::  Parse swap response: extract blinded signatures
++  parse-swap-response
  |=  jon=json
  ^-  (list [amount=@ud id=@t c-hex=@t])
  ?.  ?=([%o *] jon)  ~
  (parse-sigs (~(gut by p.jon) 'signatures' ~))
::  +parse-sigs: a json array of blinded signatures
::
++  parse-sigs
  |=  sigs=json
  ^-  (list [amount=@ud id=@t c-hex=@t])
  ?.  ?=([%a *] sigs)  ~
  %+  turn  p.sigs
  |=  sig=json
  ^-  [amount=@ud id=@t c-hex=@t]
  ?.  ?=([%o *] sig)  [0 '' '']
  =/  amt=json  (~(gut by p.sig) 'amount' [%n '0'])
  =/  kid=json  (~(gut by p.sig) 'id' [%s ''])
  =/  c-val=json  (~(gut by p.sig) 'C_' [%s ''])
  =/  amount=@ud
    ?.  ?=([%n *] amt)  0
    (roll (trip p.amt) |=([c=@ a=@ud] (add (mul a 10) (sub c '0'))))
  =/  keyset-id=@t
    ?.  ?=([%s *] kid)  ''
    p.kid
  =/  c-hex=@t
    ?.  ?=([%s *] c-val)  ''
    p.c-val
  [amount keyset-id c-hex]
::
::  Unblind all signatures and produce final proofs
++  finalize-proofs
  |=  $:  sigs=(list [amount=@ud id=@t c-hex=@t])
          secrets=(list @t)
          blinding-factors=(list @)
          mint-keys=(map @ud [x=@ y=@])
      ==
  ^-  (list [amount=@ud id=@t secret=@t c=@t])
  =/  idx=@ud  0
  =/  acc=(list [amount=@ud id=@t secret=@t c=@t])  ~
  |-
  ?:  |((gte idx (lent sigs)) (gte idx (lent secrets)) (gte idx (lent blinding-factors)))
    (flop acc)
  =/  [amt=@ud kid=@t c-hex=@t]  (snag idx sigs)
  =/  secret=@t  (snag idx secrets)
  =/  r=@  (snag idx blinding-factors)
  =/  mint-key  (~(get by mint-keys) amt)
  ?~  mint-key
    $(idx +(idx))
  =/  c-blind  (hex-to-point c-hex)
  =/  c-unblind  (unblind-signature c-blind r u.mint-key)
  =/  c-final=@t  (point-to-hex c-unblind)
  $(idx +(idx), acc [[amt kid secret c-final] acc])
::
::  -- NUT-05 melt (Lightning withdrawal) --
::
::  Build melt quote request
++  build-melt-quote-request
  |=  [invoice=@t unit=@t]
  ^-  json
  %-  pairs:enjs:format
  :~  ['request' s+invoice]
      ['unit' s+unit]
  ==
::
::  Parse melt quote response
++  parse-melt-quote
  |=  jon=json
  ^-  (unit [quote=@t amount=@ud fee-reserve=@ud])
  ?.  ?=([%o *] jon)  ~
  =/  q  (~(get by p.jon) 'quote')
  =/  a  (~(get by p.jon) 'amount')
  =/  f  (~(get by p.jon) 'fee_reserve')
  ?~  q  ~
  ?~  a  ~
  ?~  f  ~
  :-  ~
  :+  ?:(?=([%s *] u.q) p.u.q '')
    ?:(?=([%n *] u.a) (roll (trip p.u.a) |=([c=@ a=@ud] (add (mul a 10) (sub c '0')))) 0)
  ?:(?=([%n *] u.f) (roll (trip p.u.f) |=([c=@ a=@ud] (add (mul a 10) (sub c '0')))) 0)
::
::  Build melt execution request from stored proofs, with blank outputs
::  for the change (NUT-08)
++  build-melt-request
  |=  [quote-id=@t proofs=(list [amount=@ud id=@t secret=@t c=@t]) outputs=(list [amount=@ud id=@t b-hex=@t])]
  ^-  json
  %-  pairs:enjs:format
  :~  ['quote' s+quote-id]
      ['outputs' (outputs-json outputs)]
      :-  'inputs'
      :-  %a
      %+  turn  proofs
      |=  [amount=@ud id=@t secret=@t c=@t]
      %-  pairs:enjs:format
      :~  ['amount' (numb:enjs:format amount)]
          ['id' s+id]
          ['secret' s+secret]
          ['C' s+c]
      ==
  ==
::
::  Parse melt response
++  parse-melt-response
  |=  jon=json
  ^-  (unit [state=@t paid=?])
  ?.  ?=([%o *] jon)  ~
  =/  st  (~(get by p.jon) 'state')
  ?~  st  ~
  =/  state=@t  ?:(?=([%s *] u.st) p.u.st '')
  `[state =(state 'PAID')]
::
::  +parse-melt-change: the change a paid melt returns on our blank
::  outputs (NUT-08), in their order
++  parse-melt-change
  |=  jon=json
  ^-  (list [amount=@ud id=@t c-hex=@t])
  ?.  ?=([%o *] jon)  ~
  (parse-sigs (~(gut by p.jon) 'change' ~))
::
::  -- NUT-04 mint (Lightning invoice) --
::
::  Build mint quote request
++  build-mint-quote-request
  |=  [amount=@ud unit=@t]
  ^-  json
  %-  pairs:enjs:format
  :~  ['amount' (numb:enjs:format amount)]
      ['unit' s+unit]
  ==
::
::  Parse mint quote response
++  parse-mint-quote
  |=  jon=json
  ^-  (unit [quote=@t request=@t state=@t expiry=@ud])
  ?.  ?=([%o *] jon)  ~
  =/  q  (~(get by p.jon) 'quote')
  =/  r  (~(get by p.jon) 'request')
  =/  s  (~(get by p.jon) 'state')
  =/  e  (~(get by p.jon) 'expiry')
  ?~  q  ~
  ?~  r  ~
  ?~  s  ~
  ?~  e  ~
  :-  ~
  :^    ?:(?=([%s *] u.q) p.u.q '')
      ?:(?=([%s *] u.r) p.u.r '')
    ?:(?=([%s *] u.s) p.u.s '')
  ?:(?=([%n *] u.e) (roll (trip p.u.e) |=([c=@ a=@ud] (add (mul a 10) (sub c '0')))) 0)
::
::  Build mint token request (NUT-04 step 2)
++  build-mint-request
  |=  [quote-id=@t outputs=(list [amount=@ud id=@t b-hex=@t])]
  ^-  json
  %-  pairs:enjs:format
  :~  ['quote' s+quote-id]
      :-  'outputs'
      :-  %a
      %+  turn  outputs
      |=  [amount=@ud id=@t b-hex=@t]
      %-  pairs:enjs:format
      :~  ['amount' (numb:enjs:format amount)]
          ['id' s+id]
          ['B_' s+b-hex]
      ==
  ==
::
::  -- Keyset parsing --
::
::  Parse a /v1/keys response, {keysets: [{keys: ...}]} or a bare
::  {keys: ...}, as amount -> hex pubkey. ~ when it holds no keys.
++  parse-keys
  |=  jon=json
  ^-  (unit (map @ud @t))
  ?.  ?=([%o *] jon)  ~
  =/  keys=(unit json)
    =/  ks  (~(get by p.jon) 'keysets')
    ?.  ?=([~ %a ^] ks)  (~(get by p.jon) 'keys')
    ?.  ?=([%o *] i.p.u.ks)  (~(get by p.jon) 'keys')
    (~(get by p.i.p.u.ks) 'keys')
  ?.  ?=([~ %o *] keys)  ~
  :-  ~
  %-  ~(rep by p.u.keys)
  |=  [[k=@t v=json] acc=(map @ud @t)]
  =/  amt  (rush k dum:ag)
  ?.  &(?=(^ amt) ?=([%s *] v))  acc
  ?:  =(0 u.amt)  acc
  (~(put by acc) u.amt p.v)
::
::  -- NUT-02 keysets and fees --
::
+$  keyset  [id=@t unit=@t active=? fee=@ud]
::
::  Parse /v1/keysets: each keyset's id, unit, whether it is active, and
::  its input fee in parts per thousand
++  parse-keysets
  |=  jon=json
  ^-  (list keyset)
  ?.  ?=([%o *] jon)  ~
  =/  ks  (~(get by p.jon) 'keysets')
  ?.  ?=([~ %a *] ks)  ~
  %+  murn  p.u.ks
  |=  k=json
  ^-  (unit keyset)
  ?.  ?=([%o *] k)  ~
  =/  id  (~(get by p.k) 'id')
  =/  un  (~(get by p.k) 'unit')
  ?.  &(?=([~ %s *] id) ?=([~ %s *] un))  ~
  =/  fe  (~(get by p.k) 'input_fee_ppk')
  :-  ~
  :^  p.u.id  p.u.un  =([~ %b %.y] (~(get by p.k) 'active'))
  ?.(?=([~ %n *] fe) 0 (fall (rush p.u.fe dem) 0))
::
::  +active-sat: the keyset a mint signs new sat outputs under
++  active-sat
  |=  ks=(list keyset)
  ^-  (unit keyset)
  =/  a  (skim ks |=(k=keyset &(active.k =('sat' unit.k))))
  ?~(a ~ `i.a)
::
::  +input-fee: what a mint keeps for spending proofs of these keysets:
::  their fees per thousand, summed and rounded up. A proof may name its
::  keyset by the first bytes of the id alone (a short id).
++  input-fee
  |=  [ks=(list keyset) ids=(list @t)]
  ^-  @ud
  =/  ppk=@ud
    %+  roll  ids
    |=  [i=@t acc=@ud]
    =/  k  (skim ks |=(k=keyset &(!=('' i) =(i (end [3 (met 3 i)] id.k)))))
    ?~(k acc (add acc fee.i.k))
  (div (add ppk 999) 1.000)
::
::  -- NUT-09 restore --
::
::  Ask the mint again for its signatures on outputs it may have signed
++  build-restore-request
  |=  outputs=(list [amount=@ud id=@t b-hex=@t])
  ^-  json
  (pairs:enjs:format ~[['outputs' (outputs-json outputs)]])
::
::  +parse-restore: the signatures the mint holds, by the B_ each signs;
::  ~ when this is no restore answer (one without its outputs)
++  parse-restore
  |=  jon=json
  ^-  (unit (map @t [amount=@ud id=@t c-hex=@t]))
  ?.  ?=([%o *] jon)  ~
  =/  os  (~(get by p.jon) 'outputs')
  ?.  ?=([~ %a *] os)  ~
  =/  sigs  (parse-sigs (~(gut by p.jon) 'signatures' ~))
  ?.  =((lent p.u.os) (lent sigs))  ~
  =|  acc=(map @t [amount=@ud id=@t c-hex=@t])
  =/  bs=(list json)  p.u.os
  |-
  ?~  bs  `acc
  ?~  sigs  `acc
  =/  b  ?.(?=([%o *] i.bs) ~ (~(get by p.i.bs) 'B_'))
  =?  acc  ?=([~ %s *] b)  (~(put by acc) p.u.b i.sigs)
  $(bs t.bs, sigs t.sigs)
::
::  -- NUT-07 checkstate --
::
::  +proof-y: the point a mint files a proof's state under, Y = hash_to_curve(secret)
++  proof-y
  |=  secret=@t
  ^-  @t
  (point-to-hex (hash-to-curve secret))
::
++  build-checkstate-request
  |=  ys=(list @t)
  ^-  json
  (pairs:enjs:format ~[['Ys' [%a (turn ys |=(y=@t s+y))]]])
::
::  +parse-checkstate: each Y's state (UNSPENT, PENDING or SPENT); ~ when
::  this is no checkstate answer
++  parse-checkstate
  |=  jon=json
  ^-  (unit (map @t @t))
  ?.  ?=([%o *] jon)  ~
  =/  st  (~(get by p.jon) 'states')
  ?.  ?=([~ %a *] st)  ~
  :-  ~
  %-  malt
  %+  murn  p.u.st
  |=  s=json
  ^-  (unit [@t @t])
  ?.  ?=([%o *] s)  ~
  =/  y  (~(get by p.s) 'Y')
  =/  v  (~(get by p.s) 'state')
  ?.  &(?=([~ %s *] y) ?=([~ %s *] v))  ~
  `[p.u.y p.u.v]
::
::  +verdict: what a checkstate answer says of all our proofs together:
::  SPENT if any is, else PENDING if any is, else UNSPENT when it names
::  every one; ~ when it doesn't
++  verdict
  |=  [states=(map @t @t) n=@ud]
  ^-  (unit @t)
  =/  vs=(list @t)  ~(val by states)
  ?:  (lien vs |=(v=@t =('SPENT' v)))  `'SPENT'
  ?:  (lien vs |=(v=@t =('PENDING' v)))  `'PENDING'
  ?.  &(=(n (lent vs)) (levy vs |=(v=@t =('UNSPENT' v))))  ~
  `'UNSPENT'
::
::  -- telling a mint's answers apart --
::
::  A fiber takes a mint's answers in the order they come, and one to an
::  earlier request (sent before a restart, or given up on) can come
::  first. A good answer names what it answers; these say whether it
::  answers ours.
::
++  obj  |=(j=json ^-((map @t json) ?.(?=([%o *] j) ~ p.j)))
::
::  +is-keysets: a /v1/keysets answer: keysets without their keys
++  is-keysets
  |=  j=json
  ^-  ?
  =/  ks  (~(get by (obj j)) 'keysets')
  ?.  ?=([~ %a *] ks)  |
  (levy p.u.ks |=(k=json !(~(has by (obj k)) 'keys')))
::
::  +is-keys: a /v1/keys answer for this keyset
++  is-keys
  |=  [j=json kid=@t]
  ^-  ?
  =/  ks  (~(get by (obj j)) 'keysets')
  ?.  ?=([~ %a ^] ks)  |
  &(=([~ %s kid] (~(get by (obj i.p.u.ks)) 'id')) ?=(^ (parse-keys j)))
::
::  +is-quote: an answer about this quote (its state, or a melt of it)
++  is-quote
  |=  [j=json q=@t]
  ^-  ?
  =([~ %s q] (~(get by (obj j)) 'quote'))
::
::  +is-new-quote: a new quote, and for a melt, of the invoice asked
::  about when the mint says which
++  is-new-quote
  |=  [j=json invoice=(unit @t)]
  ^-  ?
  =/  o  (obj j)
  ?.  ?=([~ %s *] (~(get by o) 'quote'))  |
  =/  r  (~(get by o) 'request')
  ?~  invoice  ?=([~ %s *] r)
  |(?=(~ r) =([~ %s u.invoice] r))
::
::  +is-sigs: a swap's or a mint's signatures, one per output (and not
::  a restore answer, which names its outputs)
++  is-sigs
  |=  [j=json n=@ud]
  ^-  ?
  =/  o  (obj j)
  ?:  (~(has by o) 'outputs')  |
  ?.  ?=([~ %a *] (~(get by o) 'signatures'))  |
  =(n (lent (parse-swap-response j)))
::
::  +is-restore: a restore answer about our outputs only
++  is-restore
  |=  [j=json outs=(list out)]
  ^-  ?
  ?~  got=(parse-restore j)  |
  =/  bs  (silt (turn outs |=(o=out b.o)))
  (levy ~(tap in ~(key by u.got)) |=(b=@t (~(has in bs) b)))
::
::  +is-states: a checkstate answer about these proofs, by their Ys
++  is-states
  |=  [j=json ys=(set @t)]
  ^-  ?
  ?~  st=(parse-checkstate j)  |
  =(ys ~(key by u.st))
::
::  -- the wallet --
::
::  an output we blinded, kept until the mint signs it: its secret and
::  blinding factor turn the signature into a proof
+$  out  [amount=@ud id=@t secret=@t r=@ b=@t]
+$  proof  [amount=@ud id=@t secret=@t c=@t]
::
::  +token-inputs: the proofs a payer's token hands over, as the paywall
::  sends them ({"inputs": [...]}), each with its amount, keyset id,
::  secret and C; with their sum and keyset ids. ~ when it is no such
::  token, or a huge one
++  token-inputs
  |=  tokens=@t
  ^-  (unit [inputs=json total=@ud ids=(list @t)])
  ?.  (lte (met 3 tokens) 65.536)  ~
  ?~  jon=(de:json:html tokens)  ~
  ?.  ?=([%o *] u.jon)  ~
  =/  ins  (~(get by p.u.jon) 'inputs')
  ?~  ins  ~
  ?~  s=(inputs-sum u.ins)  ~
  `[u.ins u.s]
::
::  +inputs-sum: the sum of a token's proofs, and their keyset ids; ~
::  unless it is 1 to 100 proofs, each whole
++  inputs-sum
  |=  ins=json
  ^-  (unit [total=@ud ids=(list @t)])
  ?.  ?=([%a ^] ins)  ~
  ?:  (gth (lent p.ins) 100)  ~
  =/  got=(list [@ud @t])
    %+  murn  p.ins
    |=  i=json
    ^-  (unit [@ud @t])
    ?.  ?=([%o *] i)  ~
    =/  a  (~(get by p.i) 'amount')
    =/  k  (~(get by p.i) 'id')
    ?.  ?&  ?=([~ %n *] a)  ?=([~ %s *] k)
            ?=([~ %s *] (~(get by p.i) 'secret'))
            ?=([~ %s *] (~(get by p.i) 'C'))
        ==
      ~
    =/  n  (rush p.u.a dem)
    ?:  |(?=(~ n) =([~ 0] n))  ~
    `[(need n) p.u.k]
  ?.  =((lent got) (lent p.ins))  ~
  `[(roll (turn got head) add) (turn got tail)]
::
::  +new-outs: outputs for these amounts, each from its own entropy
++  new-outs
  |=  [amounts=(list @ud) kid=@t eny=@]
  ^-  (list out)
  =|  i=@ud
  |-
  ?~  amounts  ~
  =/  o  (make-output i.amounts kid (sham [eny i]))
  :-  [i.amounts kid secret.o blinding-factor.o b-hex.o]
  $(amounts t.amounts, i +(i))
::
::  +out-reqs: outputs as a request carries them
++  out-reqs
  |=  outs=(list out)
  ^-  (list [amount=@ud id=@t b-hex=@t])
  (turn outs |=(o=out [amount.o id.o b.o]))
::
::  +keys-points: a keyset's keys as curve points; a bad key is left out
++  keys-points
  |=  keys=(map @ud @t)
  ^-  (map @ud [x=@ y=@])
  %-  ~(rep by keys)
  |=  [[a=@ud h=@t] acc=(map @ud [x=@ y=@])]
  =/  p  (mule |.((hex-to-point h)))
  ?:(?=(%| -.p) acc (~(put by acc) a p.p))
::
::  +outs-proofs: the proofs the signatures on our outputs make, in order
++  outs-proofs
  |=  [outs=(list out) sigs=(list [amount=@ud id=@t c-hex=@t]) keys=(map @ud @t)]
  ^-  (list proof)
  %:  finalize-proofs
    sigs
    (turn outs |=(o=out secret.o))
    (turn outs |=(o=out r.o))
    (keys-points keys)
  ==
::
::  +restored-proofs: the proofs a restore answer makes of our outputs:
::  those the mint had signed, matched by B_
++  restored-proofs
  |=  [outs=(list out) got=(map @t [amount=@ud id=@t c-hex=@t]) keys=(map @ud @t)]
  ^-  (list proof)
  =/  have  (skim outs |=(o=out (~(has by got) b.o)))
  (outs-proofs have (turn have |=(o=out (~(got by got) b.o))) keys)
::
::  +blank-count: how many blank outputs catch a melt's change: enough
::  for every power of two up to what could come back (NUT-08)
++  blank-count
  |=  over=@ud
  ^-  @ud
  (max 1 (xeb over))
::
::  +select-proofs: proofs enough to pay `need` plus the fee spending
::  them costs, largest first; ~ when the wallet can't
++  select-proofs
  |=  [have=(list proof) need=@ud ks=(list keyset)]
  ^-  (unit (list proof))
  =/  big  (sort have |=([a=proof b=proof] (gth amount.a amount.b)))
  =|  got=(list proof)
  =|  sum=@ud
  |-
  ?:  (gte sum (add need (input-fee ks (turn got |=(p=proof id.p)))))
    `got
  ?~  big  ~
  $(big t.big, got [i.big got], sum (add sum amount.i.big))
::
::  -- Amount splitting --
::
::  Split amount into powers of 2 (standard Cashu denomination)
++  split-amount
  |=  total=@ud
  ^-  (list @ud)
  ?:  =(0 total)  ~
  =/  acc=(list @ud)  ~
  =/  bit=@ud  0
  |-
  ?:  (gte (bex bit) (mul 2 total))
    acc
  ?:  =((mod (div total (bex bit)) 2) 1)
    $(bit +(bit), acc [(bex bit) acc])
  $(bit +(bit))
::
::  -- URL helpers --
::
++  clean-mint-url
  |=  mint=@t
  ^-  tape
  =/  clean=tape  (trip mint)
  =/  rev  (flop clean)
  =?  clean  ?=([%'/' *] rev)
    (snip clean)
  clean
--
