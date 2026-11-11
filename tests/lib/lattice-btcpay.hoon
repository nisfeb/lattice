::  Unit tests for /lib/lattice-btcpay (from armillary): the requests and the readers.
::
::    A create request is checked by decoding the JSON body it made
::    back into a document, so the assertion reads as the fields
::    BTCPay's Greenfield API documents rather than as one long string.
::
/+  *test, ab=lattice-btcpay
|%
++  url    'http://127.0.0.1:3401'
++  store  'store1'
++  key    'k'
++  back   'https://ex.com/apps/armillary/pay/return?ship=~feb&nonce=n1&rail=btcpay'
::  +body-json: a built request's body, read back as a document
::
++  body-json
  |=  req=request:http
  ^-  json
  =/  bod=(unit octs)  body.req
  ?~  bod  ~
  (fall (de:json:html q.u.bod) ~)
::  ==  money
::
++  test-dollars-of
  ;:  weld
    (expect-eq !>('1.00') !>((dollars-of:ab 1.000.000)))
    (expect-eq !>('1.51') !>((dollars-of:ab 1.505.000)))
    (expect-eq !>('0.01') !>((dollars-of:ab 5.000)))
  ==
++  test-dollars-of-zero
  ;:  weld
    (expect-eq !>('0.00') !>((dollars-of:ab 0)))
    (expect-eq !>('12.34') !>((dollars-of:ab 12.340.000)))
  ==
++  test-micro-of
  ;:  weld
    (expect-eq !>(`(unit @ud)`[~ 12.340.000]) !>((micro-of:ab '12.34')))
    (expect-eq !>(`(unit @ud)`[~ 500.000]) !>((micro-of:ab '0.5')))
  ==
++  test-micro-of-junk
  ;:  weld
    (expect-eq !>(`(unit @ud)`~) !>((micro-of:ab 'x')))
    (expect-eq !>(`(unit @ud)`~) !>((micro-of:ab '1.2.3')))
  ==
::  ==  the builders
::
++  test-invoice-request-head
  =/  req=request:http
    (invoice-request:ab url store key '~feb' 'n1' 1.000.000 back)
  ;:  weld
    (expect-eq !>(%'POST') !>(method.req))
    %+  expect-eq
      !>('http://127.0.0.1:3401/api/v1/stores/store1/invoices')
    !>(url.req)
    %+  expect-eq
      !>(`(unit @t)`[~ 'token k'])
    !>((get-header:http 'authorization' header-list.req))
    %+  expect-eq
      !>(`(unit @t)`[~ 'application/json'])
    !>((get-header:http 'content-type' header-list.req))
  ==
++  test-invoice-request-body
  =/  req=request:http
    (invoice-request:ab url store key '~feb' 'n1' 1.000.000 back)
  =/  jon=json  (body-json req)
  =/  meta=json  (gj:ab jon 'metadata')
  =/  check=json  (gj:ab jon 'checkout')
  ;:  weld
    (expect-eq !>('1.00') !>((gs:ab jon 'amount')))
    (expect-eq !>('USD') !>((gs:ab jon 'currency')))
    (expect-eq !>('~feb') !>((gs:ab meta 'ship')))
    (expect-eq !>('n1') !>((gs:ab meta 'nonce')))
    (expect-eq !>(back) !>((gs:ab check 'redirectURL')))
    (expect-eq !>(`@ud`60) !>((gn:ab check 'expirationMinutes')))
  ==
++  test-invoice-request-rounds
  =/  req=request:http
    (invoice-request:ab url store key '~feb' 'n2' 1.505.000 back)
  (expect-eq !>('1.51') !>((gs:ab (body-json req) 'amount')))
++  test-invoice-request-slash
  =/  req=request:http
    (invoice-request:ab 'http://127.0.0.1:3401/' store key '~feb' 'n1' 5.000 back)
  %+  expect-eq
    !>('http://127.0.0.1:3401/api/v1/stores/store1/invoices')
  !>(url.req)
++  test-invoice-get-request
  =/  req=request:http  (invoice-get-request:ab url store key 'inv_1')
  ;:  weld
    (expect-eq !>(%'GET') !>(method.req))
    %+  expect-eq
      !>('http://127.0.0.1:3401/api/v1/stores/store1/invoices/inv_1')
    !>(url.req)
    %+  expect-eq
      !>(`(unit @t)`[~ 'token k'])
    !>((get-header:http 'authorization' header-list.req))
    (expect-eq !>(`(unit octs)`~) !>(body.req))
  ==
::  ==  the readers
::
++  settled-invoice
  '''
  {"id":"inv_1","checkoutLink":"http://127.0.0.1:3401/stub/pay/inv_1",
   "status":"Settled","additionalStatus":"None","amount":"1.00","currency":"USD",
   "metadata":{"ship":"~feb","nonce":"n1"},
   "createdTime":1789855500,"expirationTime":1789859100}
  '''
++  bare-invoice
  '''
  {"id":"inv_2","status":"New","amount":"2.50","currency":"USD"}
  '''
++  test-read-invoice
  =/  got  (read-invoice:ab settled-invoice)
  ?~  got  (expect !>(|))
  ;:  weld
    (expect-eq !>('inv_1') !>(id.u.got))
    (expect-eq !>('http://127.0.0.1:3401/stub/pay/inv_1') !>(link.u.got))
    (expect-eq !>('Settled') !>(status.u.got))
    (expect-eq !>('1.00') !>(amount.u.got))
    (expect-eq !>('~feb') !>(ship.u.got))
    (expect-eq !>('n1') !>(nonce.u.got))
  ==
++  test-read-invoice-bare
  =/  got  (read-invoice:ab bare-invoice)
  ?~  got  (expect !>(|))
  ;:  weld
    (expect-eq !>('inv_2') !>(id.u.got))
    (expect-eq !>('') !>(link.u.got))
    (expect-eq !>('') !>(ship.u.got))
    (expect-eq !>('') !>(nonce.u.got))
    (expect-eq !>('2.50') !>(amount.u.got))
  ==
++  test-read-invoice-junk
  =/  n=@ud  ?~((read-invoice:ab 'not json') 0 1)
  =/  m=@ud  ?~((read-invoice:ab '{"status":"New"}') 0 1)
  ;:  weld
    (expect-eq !>(`@ud`0) !>(n))
    (expect-eq !>(`@ud`0) !>(m))
  ==
++  test-settled
  ;:  weld
    (expect !>((settled:ab 'Settled')))
    (expect !>(!(settled:ab 'Processing')))
    (expect !>(!(settled:ab 'settled')))
  ==
++  test-event-of
  =/  ev=@t
    '{"type":"InvoiceSettled","invoiceId":"inv_1","storeId":"store1"}'
  %+  expect-eq
    !>(`(unit [type=@t id=@t])`[~ 'InvoiceSettled' 'inv_1'])
  !>((event-of:ab ev))
++  test-event-of-junk
  ;:  weld
    (expect-eq !>(`(unit [type=@t id=@t])`~) !>((event-of:ab 'junk')))
    (expect-eq !>(`(unit [type=@t id=@t])`~) !>((event-of:ab '{"type":"x"}')))
    %+  expect-eq
      !>(`(unit [type=@t id=@t])`~)
    !>((event-of:ab '{"invoiceId":"inv_1"}'))
  ==
::  ==  the signature
::
++  secret  'whsec_gate'
++  hook-body  '{"type":"InvoiceSettled","invoiceId":"inv_1"}'
++  good-head
  ^-  @t
  (rap 3 'sha256=' (hex-of:ab (hmac-sha256:ab secret hook-body)) ~)
++  test-verify-sig
  ;:  weld
    (expect !>((verify-sig:ab secret good-head hook-body)))
    (expect !>(!(verify-sig:ab 'other' good-head hook-body)))
  ==
++  test-verify-sig-bad
  ::  the same digest without the scheme prefix is refused, so a header
  ::  from some other signer can never be read as ours
  =/  bare=@t  (hex-of:ab (hmac-sha256:ab secret hook-body))
  ;:  weld
    (expect !>(!(verify-sig:ab secret 'sha256=deadbeef' hook-body)))
    (expect !>(!(verify-sig:ab secret bare hook-body)))
    (expect !>(!(verify-sig:ab secret '' hook-body)))
    (expect !>(!(verify-sig:ab secret good-head 'a different body')))
  ==
--
