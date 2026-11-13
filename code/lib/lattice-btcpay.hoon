::  lattice-btcpay: BTCPay Server's requests and its answers, pure (from
::  armillary's armillary-btcpay, for passes paid in bitcoin).
::
::    Every arm here builds a request:http a fiber may send, or reads a
::    body a fiber received. Nothing does IO. The api key is a sample,
::    never a constant: the seller's secret lives in /passes/secrets and
::    passes through. Import-free, as in armillary.
::
|%
::  ==  copied from /lib/armillary-http.hoon
::
++  hmac-sha256
  |=  [key=@t msg=@t]
  ^-  @ux
  ::  sha-256l reads a byts with its first byte most significant, and a
  ::  cord holds its first byte least significant, so both sides are
  ::  swapped on the way in. The digest comes back in standard order.
  (hmac-sha256l:hmac:crypto [(met 3 key) (swp 3 key)] [(met 3 msg) (swp 3 msg)])
++  hex-of
  |=  h=@ux
  ^-  @t
  =/  i=@ud  0
  =/  out=tape  ~
  |-  ^-  @t
  ?:  =(64 i)  (crip out)
  =/  nib=@  (cut 2 [i 1] h)
  =/  c=@t  ?:((lth nib 10) (add '0' nib) (add 87 nib))
  $(i +(i), out [c out])
++  same-hex
  |=  [a=@t b=@t]
  ^-  ?
  =/  x=tape  (trip a)
  =/  y=tape  (trip b)
  ?.  =((lent x) (lent y))  |
  =/  acc=@  0
  |-  ^-  ?
  ?~  x  =(0 acc)
  ?~  y  =(0 acc)
  $(x t.x, y t.y, acc (con acc (mix i.x i.y)))
::  ==  copied from /lib/armillary.hoon: json, read without crashing
::
++  gj
  |=  [jon=json k=@t]
  ^-  json
  ?.  ?=([%o *] jon)  ~
  (fall (~(get by p.jon) k) ~)
++  gs
  |=  [jon=json k=@t]
  ^-  @t
  =/  v=json  (gj jon k)
  ?:(?=([%s *] v) p.v '')
++  gn
  |=  [jon=json k=@t]
  ^-  @ud
  =/  v=json  (gj jon k)
  ?.  ?=([%n *] v)  0
  (fall (rush p.v dem) 0)
++  ga
  |=  [jon=json k=@t]
  ^-  (list json)
  =/  v=json  (gj jon k)
  ?:(?=([%a *] v) p.v ~)
::  +de-body: a response body as JSON, null when it is not JSON at all
::
++  de-body  |=(body=@t ^-(json (fall (de:json:html body) ~)))
::  +de-dec: a decimal string to an integer scaled by 10^scale. Copied
::  from /lib/armillary.hoon for the same import-free reason.
::
++  de-dec
  |=  [t=@t scale=@ud]
  ^-  (unit @ud)
  =/  tap=tape   (trip t)
  =/  whole=@ud  0
  =/  frac=@ud   0
  =/  digits=@ud  0
  =/  dotted=?   |
  =/  any=?      |
  |-  ^-  (unit @ud)
  ?~  tap
    ?.  any  ~
    `(add (mul whole (pow 10 scale)) (mul frac (pow 10 (sub scale digits))))
  =/  c=@t  i.tap
  ?:  =('.' c)
    ?:  dotted  ~
    $(tap t.tap, dotted &)
  ?.  &((gte c '0') (lte c '9'))  ~
  =/  d=@ud  (sub c '0')
  ?.  dotted
    $(tap t.tap, whole (add (mul whole 10) d), any &)
  ?:  (lth digits scale)
    $(tap t.tap, frac (add (mul frac 10) d), digits +(digits), any &)
  $(tap t.tap, any &)
::  ==  money, as BTCPay writes it
::
::  +dollars-of: microdollars as the decimal string an invoice carries.
::  BTCPay prices in whole cents, so a fraction of a cent rounds up: the
::  vendor never asks for less than it credits.
::
++  dollars-of
  |=  micro=@ud
  ^-  @t
  =/  cents=@ud  (div (add micro 9.999) 10.000)
  =/  whole=tape  (a-co:co (div cents 100))
  =/  rest=@ud  (mod cents 100)
  =/  pair=tape  ?:((lth rest 10) ['0' (a-co:co rest)] (a-co:co rest))
  (crip :(weld whole "." pair))
::  +micro-of: the other way, for the amount an invoice reports back.
::  Six places of scale is one microdollar.
::
++  micro-of  |=(t=@t ^-((unit @ud) (de-dec t 6)))
::  ==  the pieces every request shares
::
::  +heads: the two headers a create call carries. BTCPay's scheme word
::  is token, not Bearer.
::
++  heads
  |=  key=@t
  ^-  (list [@t @t])
  :~  ['authorization' (rap 3 'token ' key ~)]
      ['content-type' 'application/json']
  ==
::  +auth-only: the same without a content type, for a GET
::
++  auth-only
  |=  key=@t
  ^-  (list [@t @t])
  ~[['authorization' (rap 3 'token ' key ~)]]
::  +at: a route under the instance url, the url's trailing slash
::  dropped so two slashes never meet
::
++  at
  |=  [base=@t leaf=@t]
  ^-  @t
  =/  b=tape  (trip base)
  =/  trimmed=tape  ?:(&(?=(^ b) =('/' (rear `tape`b))) (snip `tape`b) b)
  (crip (weld trimmed (trip leaf)))
::  +invoices-at: the store's invoice collection
::
++  invoices-at
  |=  [url=@t store=@t]
  ^-  @t
  (at url (rap 3 '/api/v1/stores/' store '/invoices' ~))
::  ==  invoices
::
::  +invoice-request: one invoice for one top-up. The ship and the
::  nonce ride in the metadata, which is what makes a payment an
::  account: the webhook body is never trusted for either.
::
++  invoice-request
  |=  $:  url=@t
          store=@t
          key=@t
          ship=@t
          nonce=@t
          micro=@ud
          redirect=@t
      ==
  ^-  request:http
  =/  meta=json
    (pairs:enjs:format ~[['ship' s+ship] ['nonce' s+nonce]])
  =/  check=json
    %-  pairs:enjs:format
    :~  ['redirectURL' s+redirect]
        ['redirectAutomatically' b+&]
        ['expirationMinutes' (numb:enjs:format 60)]
    ==
  =/  doc=json
    %-  pairs:enjs:format
    :~  ['amount' s+(dollars-of micro)]
        ['currency' s+'USD']
        ['metadata' meta]
        ['checkout' check]
    ==
  =/  body=octs  (as-octs:mimes:html (en:json:html doc))
  [%'POST' (invoices-at url store) (heads key) `body]
::  +invoice-get-request: read an invoice back. This is the
::  verification: a webhook says only which invoice moved.
::
++  invoice-get-request
  |=  [url=@t store=@t key=@t id=@t]
  ^-  request:http
  =/  full=@t  (rap 3 (invoices-at url store) '/' id ~)
  [%'GET' full (auth-only key) ~]
::  +read-invoice: an invoice as the vendor needs it. checkoutLink comes
::  back on a create and is often absent on a read, so link may be ''.
::
++  read-invoice
  |=  body=@t
  ^-  (unit [id=@t link=@t status=@t amount=@t ship=@t nonce=@t])
  =/  jon=json  (de-body body)
  ?.  ?=([%o *] jon)  ~
  =/  id=@t  (gs jon 'id')
  ?:  =('' id)  ~
  =/  meta=json  (gj jon 'metadata')
  :-  ~
  :*  id
      (gs jon 'checkoutLink')
      (gs jon 'status')
      (gs jon 'amount')
      (gs meta 'ship')
      (gs meta 'nonce')
  ==
::  +settled: the one status that means the money is final. Processing
::  means seen and not yet confirmed.
::
++  settled  |=(status=@t ^-(? =('Settled' status)))
::  ==  events
::
::  +event-of: the only two things a webhook body is trusted for. The
::  invoice is read back from BTCPay by its id; nothing else in the
::  body decides anything.
::
++  event-of
  |=  body=@t
  ^-  (unit [type=@t id=@t])
  =/  jon=json  (de-body body)
  ?.  ?=([%o *] jon)  ~
  =/  type=@t  (gs jon 'type')
  ?:  =('' type)  ~
  =/  id=@t  (gs jon 'invoiceId')
  ?:  =('' id)  ~
  `[type id]
::  ==  the webhook signature
::
::  +verify-sig: BTCPay signs the raw body with the store webhook's
::  secret and writes the digest as "sha256=<hex>". The comparison
::  folds every byte, so the time it takes says nothing about where the
::  first difference was.
::
++  verify-sig
  |=  [secret=@t header=@t body=@t]
  ^-  ?
  =/  h=tape  (trip header)
  ?.  =("sha256=" (scag 7 h))  |
  =/  got=@t  (crip (slag 7 h))
  (same-hex (hex-of (hmac-sha256 secret body)) got)
--
