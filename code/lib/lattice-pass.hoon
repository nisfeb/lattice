::  lib/lattice-pass: paid passes (docs/superpowers/specs/2026-11-11-passes-design.md).
::  A pass is a holder's right to read, or read and post in, one scope
::  until a time. These arms are pure: the check run on every post and
::  web read (+live), the read group a scope's weir keeps (+group-ships),
::  buying and renewing (+extend), what the sweeper does (+due, +next-wake,
::  +prune), and the seller's numbers (+summary).
::
|%
+$  scope   $%([%board name=@tas] [%folder pax=path] [%lodging who=@p])
+$  mode    ?(%read %post)
+$  holder  $%([%ship who=@p] [%web key=@uv])
+$  cur     ?(%sat %usd)                       ::  %usd counts cents
+$  via     ?(%ecash %lightning %card %gift)
::  an offer takes ecash and Lightning at `mint` when sats is set, and
::  card when cents is set
+$  offer
  $:  sats=@ud
      cents=@ud
      period=@dr
      =mode
      mint=(unit @t)
      open=?
  ==
+$  pass
  $:  =holder
      =mode
      until=@da
      since=@da
      paid=@ud
      =cur
      =via
      ref=@t
  ==
+$  sale   [at=@da =holder paid=@ud =cur =via refund=?]
+$  held   (map holder pass)
::  +$  next: the last sweep, and each scope's next wake
+$  next   [last=@da wakes=(map @ta @da)]
::  payments: the shapes lib/lattice-cashu uses, so a pay grub reads
::  without it
+$  proof  [amount=@ud id=@t secret=@t c=@t]
+$  out    [amount=@ud id=@t secret=@t r=@ b=@t]
::  +$  mint-keys: a mint's keysets, and the one it signs sats under
+$  mint-keys  [ks=(list [id=@t unit=@t active=? fee=@ud]) kid=@t keys=(map @ud @t)]
::  +$  how: ecash in hand (a cashuA token), or a Lightning invoice asked for
+$  how    $%([%ecash token=@t] [%lightning ~])
::  +$  pay: one payment under way, in its grub /passes/pay/<id>, with
::  the offer's price, period and mode as they were when it was asked.
::  A web buyer polls with `tok`, and its pass is held by `code`'s key
+$  pay
  $:  =holder
      key=@ta
      mint=@t
      price=@ud
      period=@dr
      =mode
      =via
      tok=@uv
      code=@uv
      step=pay-step
  ==
+$  pay-step
  $%  [%swap inputs=json]
      [%swapping inputs=json keys=(map @ud @t) outs=(list out)]
      [%quote ~]
      [%invoice quote=@t bolt11=@t expiry=@da]
      [%minting quote=@t keys=(map @ud @t) outs=(list out)]
      [%done got=(list proof)]
      [%failed why=@t]
  ==
::  +$  done: how a web payment ended, kept a day for its page to read
+$  done  [at=@da tok=@uv ok=? why=@t code=@uv until=@da]
::  +$  card: a card payment under way at Stripe, by its poll token, in
::  /passes/card/<tok>, until Stripe says it is paid or an hour passes
+$  card  [key=@ta code=@uv cents=@ud period=@dr =mode at=@da sid=@t]
::  how many payments may be under way: from one holder, and in all
++  pays-each  3
++  pays-max  50
::
::  +$  pass-act: what the writer does with passes. A grant is a sale
::  settled or the seller's gift
+$  pass-act
  $%  [%offer key=@ta o=(unit offer)]
      [%grant key=@ta =holder =mode period=@dr paid=@ud =cur =via ref=@t]
      [%refund key=@ta =holder]
      [%sweep ~]
      ::  a payment asked for: by a ship (tok and code 0) or the web
      [%buy key=@ta =holder =how tok=@uv code=@uv]
      ::  a payment's fiber is done with it
      [%settle id=@ta]
      ::  the seller took the ecash from one mint out of a wallet
      [%wallet-take key=@ta mint=@t]
      ::  Stripe says a card session is paid (+card in /passes/card/<tok>)
      [%card-paid tok=@ta total=@ud sid=@t]
  ==
::
::  the sales log keeps this many, newest first
++  sales-max  1.000
::  a lapsed pass is kept this long, then pruned
++  keep-lapsed  ~d90
::  a ship hears its pass is ending this long before
++  remind  ~d3
::
::  +scope-key: the grub name a scope's records sit under. A folder is
::  its path's hash, so a deep folder is not a deep grub tree
::
++  scope-key
  |=  s=scope
  ^-  @ta
  ?-  -.s
    %board    (cat 3 'b-' name.s)
    %folder   (cat 3 'f-' (scot %uv (sham pax.s)))
    %lodging  (cat 3 'l-' (rsh [3 1] (scot %p who.s)))
  ==
::
::  +key-board: the board a scope key names, if it names one
::
++  key-board
  |=  key=@ta
  ^-  (unit @tas)
  ?.  =('b-' (end [3 2] key))  ~
  =/  n=@t  (rsh [3 2] key)
  ?.  ((sane %tas) n)  ~
  ?:  =('' n)  ~
  `n
::
::  +live: does holder h hold a pass good for `want` now. One map lookup
::
++  live
  |=  [h=held who=holder now=@da want=mode]
  ^-  ?
  =/  p  (~(get by h) who)
  ?~  p  |
  ?&  (gth until.u.p now)
      |(=(want %read) =(mode.u.p %post))
  ==
::
::  +group-ships: who the scope's read group holds: the hand invites and
::  every ship with a live pass
::
++  group-ships
  |=  [hand=(set @p) h=held now=@da]
  ^-  (set @p)
  %-  ~(uni in hand)
  %-  silt
  %+  murn  ~(val by h)
  |=  p=pass
  ?.  ?=(%ship -.holder.p)  ~
  ?.  (gth until.p now)  ~
  `who.holder.p
::
::  +extend: a purchase by `who` of `period` at mode `md`, the offer's
::  when it was paid for. A renewal runs from the old end if that is
::  still ahead, so paying early loses nothing. A comet's pass is
::  read-only, as comets cannot post on private boards
::
++  extend
  |=  [h=held who=holder md=mode period=@dr now=@da paid=@ud =cur =via ref=@t]
  ^-  pass
  =/  old  (~(get by h) who)
  =/  from=@da  ?~(old now (max now until.u.old))
  =?  md  &(?=(%ship -.who) (gth (met 3 who.who) 8))  %read
  [who md (add from period) ?~(old now since.u.old) paid cur via ref]
::
::  +refund: the pass ends now. The money goes back by hand
::
++  refund
  |=  [h=held who=holder now=@da]
  ^-  held
  =/  p  (~(get by h) who)
  ?~  p  h
  (~(put by h) who u.p(until (min now until.u.p)))
::
::  +log-sale: a sale onto the log, newest first, capped
::
++  log-sale
  |=  [s=(list sale) new=sale]
  ^-  (list sale)
  (scag sales-max `(list sale)`[new s])
::
::  +due: what a sweep at `now` acts on, for passes whose end or reminder
::  fell after the last sweep `last` and by `now`: the holders that
::  lapsed, and the ships to remind
::
++  due
  |=  [h=held last=@da now=@da]
  ^-  [lapsed=(list holder) ending=(list @p)]
  =/  in  |=(t=@da &((gth t last) (lte t now)))
  =/  ps=(list pass)  ~(val by h)
  :-  (murn ps |=(p=pass ?.((in until.p) ~ `holder.p)))
  %+  murn  ps
  |=  p=pass
  ?.  ?=(%ship -.holder.p)  ~
  ?.  (gth until.p (add since.p remind))  ~
  ?.  (in (sub until.p remind))  ~
  `who.holder.p
::
::  +next-wake: the next time a sweep has work: an end or a reminder
::  still ahead
::
++  next-wake
  |=  [h=held now=@da]
  ^-  (unit @da)
  =|  best=(unit @da)
  =/  ps=(list pass)  ~(val by h)
  |-  ^-  (unit @da)
  ?~  ps  best
  =*  p  i.ps
  =/  ts=(list @da)
    :-  until.p
    ?.  &(?=(%ship -.holder.p) (gth until.p (add since.p remind)))  ~
    ~[(sub until.p remind)]
  =.  best
    %+  roll  ts
    |=  [t=@da b=_best]
    ?.  (gth t now)  b
    ?~(b `t `(min t u.b))
  $(ps t.ps)
::
::  +soonest: the earlier of two wakes
::
++  soonest
  |=  [a=(unit @da) b=(unit @da)]
  ^-  (unit @da)
  ?~  a  b
  ?~  b  a
  `(min u.a u.b)
::
::  +prune: drop passes lapsed longer than keep-lapsed
::
++  prune
  |=  [h=held now=@da]
  ^-  held
  %-  malt
  %+  skim  ~(tap by h)
  |=  [* p=pass]
  (gth (add until.p keep-lapsed) now)
::
::  +summary: the seller's numbers. Income is net of refunds, by unit,
::  for the calendar month and the last 30 days. A lapse is a pass that
::  ended in the last 30 days and is not live now
::
+$  totals   (map cur @ud)
+$  numbers
  $:  active=@ud
      month=totals
      days=totals
      lapses=@ud
  ==
++  summary
  |=  [h=held s=(list sale) now=@da]
  ^-  numbers
  =/  ago=@da  (sub now ~d30)
  =/  start=@da
    =/  d  (yore now)
    (year d(d.t 1, h.t 0, m.t 0, s.t 0, f.t ~))
  =/  ps=(list pass)  ~(val by h)
  :*  (lent (skim ps |=(p=pass (gth until.p now))))
      (sum-since s start)
      (sum-since s ago)
      (lent (skim ps |=(p=pass &((gth until.p ago) (lte until.p now)))))
  ==
++  sum-since
  |=  [s=(list sale) from=@da]
  ^-  totals
  =/  [in=totals out=totals]
    %+  roll  s
    |=  [x=sale in=totals out=totals]
    ?.  (gte at.x from)  [in out]
    ?:  refund.x
      [in (~(put by out) cur.x (add paid.x (~(gut by out) cur.x 0)))]
    [(~(put by in) cur.x (add paid.x (~(gut by in) cur.x 0))) out]
  %-  malt
  %+  turn  ~(tap by in)
  |=  [u=cur n=@ud]
  [u (sub n (min n (~(gut by out) u 0)))]
::
::  +sane-offer: an offer a seller may set: a period from a minute to ten
::  years, and at least one way to pay. Sats need a mint to take them at
::
++  sane-offer
  |=  o=offer
  ^-  ?
  ?&  (gte period.o ~m1)
      (lte period.o ~d3660)
      |((gth sats.o 0) (gth cents.o 0))
      =(=(0 sats.o) ?=(~ mint.o))
      ?|(?=(~ mint.o) &((gth (met 3 u.mint.o) 0) (lte (met 3 u.mint.o) 512)))
  ==
::
::  +web-key: a bearer code's holder key. Only this is stored
::
++  web-key
  |=  code=@uv
  ^-  holder
  [%web (sham %lattice-pass code)]
::
::  +cashu-a: a cashuA token's mint and its proofs, as json a swap sends;
::  ~ for any other token, a token of several mints, or a big one.
::  cashuA is base64url of {"token":[{"mint", "proofs"}], ...}
::
++  cashu-a
  |=  tok=@t
  ^-  (unit [mint=@t proofs=json])
  ?.  (lte (met 3 tok) 65.536)  ~
  =/  t=tape  (trip tok)
  ?.  =("cashuA" (scag 6 t))  ~
  =/  b=tape
    %+  turn  (slag 6 t)
    |=(c=@tD ?:(=('-' c) '+' ?:(=('_' c) '/' c)))
  =.  b  (weld b (reap (mod (sub 4 (mod (lent b) 4)) 4) '='))
  =/  raw  (de:base64:mimes:html (crip b))
  ?~  raw  ~
  =/  jon  (de:json:html q.u.raw)
  ?.  ?=([~ %o *] jon)  ~
  =/  ts  (~(get by p.u.jon) 'token')
  ?.  ?=([~ %a ^ ~] ts)  ~
  =/  e  i.p.u.ts
  ?.  ?=(%o -.e)  ~
  =/  mt  (~(get by p.e) 'mint')
  =/  ps  (~(get by p.e) 'proofs')
  ?.  &(?=([~ %s *] mt) ?=([~ %a *] ps))  ~
  `[p.u.mt u.ps]
::
::  +mint-same: two mint urls, alike but for case, a scheme's slashes
::  and a trailing slash
::
++  mint-same
  |=  [a=@t b=@t]
  ^-  ?
  =/  norm
    |=  u=@t
    ^-  tape
    =/  t=tape  (flop (cass (trip u)))
    |-  ^-  tape
    ?~  t  ~
    ?:  =('/' i.t)  $(t t.t)
    (flop t)
  =((norm a) (norm b))
::
::  +cookie-name: the cookie a web pass for a scope rides in
::
++  cookie-name
  |=  key=@ta
  ^-  @t
  (cat 3 'lattice-pass-' key)
::
::  +cookie-code: the bearer code in a Cookie header for scope key, if
::  any parses
::
++  cookie-code
  |=  [hed=@t key=@ta]
  ^-  (unit @uv)
  =/  want=tape  (trip (cat 3 (cookie-name key) '='))
  =/  parts=(list tape)  (split (trip hed) "; ")
  |-  ^-  (unit @uv)
  ?~  parts  ~
  ?.  =(want (scag (lent want) i.parts))  $(parts t.parts)
  (slaw %uv (crip (slag (lent want) i.parts)))
::
++  split
  |=  [t=tape sep=tape]
  ^-  (list tape)
  =|  acc=(list tape)
  =|  cur=tape
  |-  ^-  (list tape)
  ?~  t  (flop [(flop cur) acc])
  ?:  =(sep (scag (lent sep) `tape`t))
    $(t (slag (lent sep) `tape`t), acc [(flop cur) acc], cur ~)
  $(t t.t, cur [i.t cur])
--
