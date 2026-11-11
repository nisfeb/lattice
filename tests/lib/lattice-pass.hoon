::  Unit tests for /lib/lattice-pass: the access check, the read group,
::  buying and renewing, the sweep and the seller's numbers.
::
/+  *test, lp=lattice-pass
|%
++  t0  ~2026.6.15..12.00.00
++  off
  ^-  offer:lp
  [1.000 500 ~d30 %post `'http://localhost:8080' &]
++  tot  |=(l=(list [cur:lp @ud]) ^-(totals:lp (malt l)))
++  nec  `holder:lp`[%ship ~nec]
++  bus  `holder:lp`[%ship ~bus]
++  web  (web-key:lp 0v1234)
++  mk
  |=  [who=holder:lp md=mode:lp until=@da]
  ^-  pass:lp
  [who md until (sub until ~d30) 1.000 %sat %ecash '']
++  hld
  ^-  held:lp
  %-  malt
  :~  [nec (mk nec %post (add t0 ~d10))]
      [bus (mk bus %read (add t0 ~d1))]
      [web (mk web %read (sub t0 ~d1))]
  ==
::
++  test-live
  ;:  weld
    (expect-eq !>(&) !>((live:lp hld nec t0 %read)))
    (expect-eq !>(&) !>((live:lp hld nec t0 %post)))
    (expect-eq !>(&) !>((live:lp hld bus t0 %read)))
    ::  a read pass does not post
    (expect-eq !>(|) !>((live:lp hld bus t0 %post)))
    ::  lapsed, and at the second it ends
    (expect-eq !>(|) !>((live:lp hld web t0 %read)))
    (expect-eq !>(|) !>((live:lp hld bus (add t0 ~d1) %read)))
    (expect-eq !>(&) !>((live:lp hld bus (sub (add t0 ~d1) ~s1) %read)))
    ::  no pass
    (expect-eq !>(|) !>((live:lp hld [%ship ~wet] t0 %read)))
    (expect-eq !>(|) !>((live:lp hld (web-key:lp 0v9) t0 %read)))
  ==
::
++  test-group-ships
  ;:  weld
    (expect-eq !>((silt ~[~nec ~bus ~zod])) !>((group-ships:lp (silt ~[~zod]) hld t0)))
    ::  a hand invite outlives a pass, and web holders are never ships
    (expect-eq !>((silt ~[~nec ~bus])) !>((group-ships:lp (silt ~[~bus]) hld (add t0 ~d2))))
    (expect-eq !>(*(set @p)) !>((group-ships:lp ~ hld (add t0 ~d20))))
  ==
::
++  test-extend
  =/  new  (extend:lp hld [%ship ~wet] %post ~d30 t0 1.000 %sat %ecash 'r1')
  =/  early  (extend:lp hld nec %post ~d30 t0 1.000 %sat %lightning 'r2')
  =/  late   (extend:lp hld web %read ~d30 t0 500 %usd %card 'cs_1')
  =/  comet  (extend:lp hld [%ship `@p`(bex 100)] %post ~d30 t0 1.000 %sat %ecash '')
  ;:  weld
    (expect-eq !>([(add t0 ~d30) t0 %post]) !>([until.new since.new mode.new]))
    ::  renewing early runs from the old end, and keeps since
    (expect-eq !>((add t0 ~d40)) !>(until.early))
    (expect-eq !>((sub (add t0 ~d10) ~d30)) !>(since.early))
    (expect-eq !>([%lightning 'r2']) !>([via.early ref.early]))
    ::  renewing after a lapse runs from now
    (expect-eq !>((add t0 ~d30)) !>(until.late))
    (expect-eq !>([500 %usd]) !>([paid.late cur.late]))
    ::  a comet reads only
    (expect-eq !>(%read) !>(mode.comet))
  ==
::
++  test-refund
  =/  h  (refund:lp hld nec t0)
  ;:  weld
    (expect-eq !>(|) !>((live:lp h nec t0 %read)))
    (expect-eq !>(t0) !>(until:(~(got by h) nec)))
    ::  a lapsed pass keeps its end, and a refund of none changes nothing
    (expect-eq !>((sub t0 ~d1)) !>(until:(~(got by (refund:lp hld web t0)) web)))
    (expect-eq !>(hld) !>((refund:lp hld [%ship ~wet] t0)))
  ==
::
++  test-due
  ::  nec ends at t0+10d, so its reminder is at t0+7d
  ;:  weld
    (expect-eq !>([~[bus] ~]) !>((due:lp hld t0 (add t0 ~d1))))
    (expect-eq !>([~ ~[~nec]]) !>((due:lp hld (add t0 ~d6) (add t0 ~d7))))
    (expect-eq !>([~[nec] ~]) !>((due:lp hld (add t0 ~d9) (add t0 ~d10))))
    ::  a sweep that came late still catches both
    (expect-eq !>([~[nec] ~[~nec]]) !>((due:lp hld (add t0 ~d6) (add t0 ~d11))))
    ::  nothing twice: the window is after last
    (expect-eq !>([~ ~]) !>((due:lp hld (add t0 ~d10) (add t0 ~d12))))
    ::  a web pass gets no reminder, and a pass shorter than the reminder none
    =/  short  (malt ~[[nec [nec %read (add t0 ~d2) t0 1 %sat %gift '']]])
    (expect-eq !>([~ ~]) !>((due:lp short t0 (add t0 ~d1))))
  ==
::
++  test-next-wake
  ;:  weld
    (expect-eq !>(`(add t0 ~d1)) !>((next-wake:lp hld t0)))
    (expect-eq !>(`(add t0 ~d7)) !>((next-wake:lp hld (add t0 ~d1))))
    (expect-eq !>(`(add t0 ~d10)) !>((next-wake:lp hld (add t0 ~d7))))
    (expect-eq !>(~) !>((next-wake:lp hld (add t0 ~d10))))
    (expect-eq !>(`~2026.1.1) !>((soonest:lp `~2026.1.1 `~2026.2.1)))
    (expect-eq !>(`~2026.2.1) !>((soonest:lp ~ `~2026.2.1)))
  ==
::
++  test-prune
  ;:  weld
    (expect-eq !>(3) !>(~(wyt by (prune:lp hld t0))))
    ::  web lapsed at t0-1d, so it goes 90 days after that
    (expect-eq !>(3) !>(~(wyt by (prune:lp hld (add t0 ~d88)))))
    (expect-eq !>(|) !>((~(has by (prune:lp hld (add t0 ~d89))) web)))
    (expect-eq !>(&) !>((~(has by (prune:lp hld (add t0 ~d89))) nec)))
  ==
::
++  test-summary
  =/  s=(list sale:lp)
    :~  [(sub t0 ~h1) nec 1.000 %sat %ecash |]
        [(sub t0 ~h2) web 500 %usd %card |]
        [(sub t0 ~h3) nec 300 %sat %ecash &]
        [(sub t0 ~d20) bus 1.000 %sat %lightning |]
        [(sub t0 ~d40) bus 9.000 %sat %ecash |]
    ==
  =/  n  (summary:lp hld s t0)
  ;:  weld
    (expect-eq !>(2) !>(active.n))
    (expect-eq !>(1) !>(lapses.n))
    ::  the month began on the 1st: t0-20d is in May, so not counted
    (expect-eq !>((tot ~[[%sat 700] [%usd 500]])) !>(month.n))
    (expect-eq !>((tot ~[[%sat 1.700] [%usd 500]])) !>(days.n))
    ::  a refund bigger than the income is zero, never under
    (expect-eq !>((tot ~[[%sat 0]])) !>((sum-since:lp ~[[t0 nec 5 %sat %gift &] [t0 nec 1 %sat %gift |]] (sub t0 ~d1))))
  ==
::
++  test-log-sale
  =/  big  (reap sales-max:lp `sale:lp`[t0 nec 1 %sat %ecash |])
  =/  s  (log-sale:lp big [(add t0 ~s1) bus 2 %sat %ecash |])
  ;:  weld
    (expect-eq !>(sales-max:lp) !>((lent s)))
    (expect-eq !>(bus) !>(holder:(snag 0 s)))
  ==
::
++  test-sane-offer
  =/  o=offer:lp  off
  ;:  weld
    (expect-eq !>(&) !>((sane-offer:lp off)))
    (expect-eq !>(&) !>((sane-offer:lp o(sats 0, mint ~))))
    (expect-eq !>(&) !>((sane-offer:lp o(cents 0))))
    (expect-eq !>(|) !>((sane-offer:lp o(sats 0, cents 0, mint ~))))
    ::  sats need a mint, and a mint needs sats
    (expect-eq !>(|) !>((sane-offer:lp o(mint ~))))
    (expect-eq !>(|) !>((sane-offer:lp o(sats 0))))
    (expect-eq !>(|) !>((sane-offer:lp o(mint `''))))
    (expect-eq !>(|) !>((sane-offer:lp o(period ~s59))))
    (expect-eq !>(&) !>((sane-offer:lp o(period ~m1))))
    (expect-eq !>(|) !>((sane-offer:lp o(period ~d3661))))
  ==
::
++  test-scope-key
  ;:  weld
    (expect-eq !>(%b-main) !>((scope-key:lp [%board %main])))
    (expect-eq !>(%l-nec) !>((scope-key:lp [%lodging ~nec])))
    (expect-eq !>(&) !>(=('f-' (end [3 2] (scope-key:lp [%folder /a/b])))))
    (expect-eq !>(34) !>((met 3 (scope-key:lp [%folder /a/b]))))
    (expect-eq !>(~) !>((find "." (trip (scope-key:lp [%folder /a/b])))))
    (expect-eq !>(|) !>(=((scope-key:lp [%folder /a/b]) (scope-key:lp [%folder /a/c]))))
  ==
::
++  test-key-board
  ;:  weld
    (expect-eq !>(`%main) !>((key-board:lp %b-main)))
    (expect-eq !>(~) !>((key-board:lp %b-)))
    (expect-eq !>(~) !>((key-board:lp %l-nec)))
    (expect-eq !>(~) !>((key-board:lp 'b-Bad')))
  ==
::
++  test-cashu-a
  ::  {"token":[{"mint":"http://m","proofs":[{"amount":1}]}]}, base64url
  ::  with its padding cut, as wallets write it
  =/  good=@t  'cashuAeyJ0b2tlbiI6W3sibWludCI6Imh0dHA6Ly9tIiwicHJvb2ZzIjpbeyJhbW91bnQiOjF9XX1dfQ'
  =/  got  (cashu-a:lp good)
  ;:  weld
    (expect-eq !>(`'http://m') !>(?~(got ~ `mint.u.got)))
    (expect-eq !>(1) !>(?~(got 0 ?.(?=(%a -.proofs.u.got) 0 (lent p.proofs.u.got)))))
    (expect-eq !>(~) !>((cashu-a:lp 'cashuBo2F0')))
    (expect-eq !>(~) !>((cashu-a:lp 'cashuA!!!')))
    (expect-eq !>(~) !>((cashu-a:lp 'hello')))
    ::  two mints in one token
    (expect-eq !>(~) !>((cashu-a:lp 'cashuAeyJ0b2tlbiI6W3sibWludCI6ImEiLCJwcm9vZnMiOltdfSx7Im1pbnQiOiJiIiwicHJvb2ZzIjpbXX1dfQ')))
  ==
::
++  test-mint-same
  ;:  weld
    (expect-eq !>(&) !>((mint-same:lp 'http://Mint.example/' 'http://mint.example')))
    (expect-eq !>(|) !>((mint-same:lp 'http://mint.example' 'http://mint.other')))
  ==
::
++  test-cookie
  =/  key  %b-main
  ;:  weld
    (expect-eq !>(`0v1234) !>((cookie-code:lp 'lattice-pass-b-main=0v1234' key)))
    (expect-eq !>(`0v1234) !>((cookie-code:lp 'a=1; lattice-pass-b-main=0v1234; z=2' key)))
    ::  another board's cookie, a prefix of the name, and junk
    (expect-eq !>(~) !>((cookie-code:lp 'lattice-pass-b-other=0v1234' key)))
    (expect-eq !>(~) !>((cookie-code:lp 'lattice-pass-b-mainx=0v1234' key)))
    (expect-eq !>(~) !>((cookie-code:lp 'lattice-pass-b-main=zz' key)))
    (expect-eq !>(~) !>((cookie-code:lp '' key)))
    ::  the stored key is not the code
    (expect-eq !>(|) !>(=([%web 0v1234] (web-key:lp 0v1234))))
  ==
--
