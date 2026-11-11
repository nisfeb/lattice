::  tests for lib/lattice-stripe (from register's register-stripe and
::  register-http suites): the Stripe calls, built and read, and form encoding
::
/+  *test, stripe=lattice-stripe, http=lattice-stripe
|%
++  lines  ~[['Registration' 15.000] ['Gift to the Baby Steps Camino' 5.000]]
::
++  body
  ^-  @t
  %-  form-body:http
  (checkout-body:stripe 'r1' 'a@b.com' lines 'https://x.test/ok' 'https://x.test/no' 1.800.000.000)
::
++  has
  |=  t=@t
  ^-  ?
  ?=(^ (find (trip t) (trip body)))
::
++  test-checkout-mode
  (expect-eq !>(&) !>((has 'mode=payment')))
::
++  test-checkout-rid
  (expect-eq !>(&) !>((has 'metadata%5Brid%5D=r1')))
::
++  test-checkout-email
  (expect-eq !>(&) !>((has 'customer_email=a%40b.com')))
::
++  test-checkout-urls
  ;:  weld
    (expect-eq !>(&) !>((has 'success_url=https%3A%2F%2Fx.test%2Fok')))
    (expect-eq !>(&) !>((has 'cancel_url=https%3A%2F%2Fx.test%2Fno')))
  ==
::
++  test-checkout-expires
  (expect-eq !>(&) !>((has 'expires_at=1800000000')))
::
++  test-checkout-lines
  ;:  weld
    (expect-eq !>(&) !>((has 'line_items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=15000')))
    (expect-eq !>(&) !>((has 'line_items%5B1%5D%5Bprice_data%5D%5Bunit_amount%5D=5000')))
    (expect-eq !>(&) !>((has 'line_items%5B1%5D%5Bquantity%5D=1')))
  ==
::
++  test-checkout-no-email
  ::  an empty address is left out rather than sent empty
  =/  b=@t
    %-  form-body:http
    (checkout-body:stripe 'r1' '' lines 'u' 'v' 0)
  (expect-eq !>(~) !>((find "customer_email" (trip b))))
::
++  test-read-session-paid
  =/  j=@t
    '{"id":"cs_test_1","payment_status":"paid","amount_total":20000,"metadata":{"rid":"r1"},"url":"https://pay.test/1"}'
  (expect-eq !>(`['cs_test_1' & 20.000 'r1' 'https://pay.test/1']) !>((read-session:stripe j)))
::
++  test-read-session-unpaid
  =/  j=@t  '{"id":"cs_test_2","payment_status":"unpaid","amount_total":0,"metadata":{},"url":""}'
  =/  r  (read-session:stripe j)
  ?~  r  (expect-eq !>(&) !>(|))
  (expect-eq !>(|) !>(paid.u.r))
::
++  test-read-session-garbage
  ;:  weld
    (expect-eq !>(~) !>((read-session:stripe 'not json')))
    (expect-eq !>(~) !>((read-session:stripe '{"error":{"message":"no such session"}}')))
  ==
::
++  test-webhook-sid
  =/  j=@t
    '{"type":"checkout.session.completed","data":{"object":{"id":"cs_test_9","object":"checkout.session"}}}'
  (expect-eq !>(`'cs_test_9') !>((webhook-sid:stripe j)))
::
++  test-webhook-not-a-session-id
  ::  the route this feeds is public: an id that is not a session id
  ::  must not become an outbound call
  ;:  weld
    (expect-eq !>(~) !>((webhook-sid:stripe '{"type":"checkout.session.completed","data":{"object":{"id":"pi_1"}}}')))
    (expect-eq !>(~) !>((webhook-sid:stripe '{"type":"checkout.session.completed","data":{"object":{"id":""}}}')))
    (expect-eq !>(~) !>((webhook-sid:stripe '{"type":"checkout.session.completed","data":{}}')))
  ==
::
++  test-webhook-other-event
  =/  j=@t
    '{"type":"payment_intent.succeeded","data":{"object":{"id":"pi_1"}}}'
  (expect-eq !>(~) !>((webhook-sid:stripe j)))
::
++  test-read-livemode
  ;:  weld
    (expect-eq !>(`|) !>((read-livemode:stripe '{"object":"balance","livemode":false}')))
    (expect-eq !>(`&) !>((read-livemode:stripe '{"object":"balance","livemode":true}')))
    (expect-eq !>(~) !>((read-livemode:stripe '{"error":{"message":"bad key"}}')))
  ==
++  test-url-encode-plain
  %+  expect-eq
    !>  'abcXYZ019-._~'
    !>  (url-encode:http 'abcXYZ019-._~')
::
++  test-url-encode-edges
  ::  both ends of all three ranges, and the bytes just outside them.
  ::  A range that loses an end encodes a letter it should have passed.
  ;:  weld
    (expect-eq !>('azAZ09') !>((url-encode:http 'azAZ09')))
    ::  '@' is 'A' - 1, '[' is 'Z' + 1, '`' is 'a' - 1, '{' is 'z' + 1,
    ::  '/' is '0' - 1 and ':' is '9' + 1
    (expect-eq !>('%40%5B%60%7B%2F%3A') !>((url-encode:http '@[`{/:')))
  ==
::
++  test-url-encode-space-and-amp
  %+  expect-eq
    !>  'a%20b%26c'
    !>  (url-encode:http 'a b&c')
::
++  test-url-encode-utf8
  ::  é is two bytes, C3 A9, and both are encoded
  %+  expect-eq
    !>  '%C3%A9'
    !>  (url-encode:http 'é')
::
++  test-url-encode-brackets
  %+  expect-eq
    !>  'line_items%5B0%5D%5Bprice%5D'
    !>  (url-encode:http 'line_items[0][price]')
::
++  test-url-encode-empty
  %+  expect-eq
    !>  ''
    !>  (url-encode:http '')
::
++  test-form-body-two-keys
  %+  expect-eq
    !>  'mode=payment&customer_email=a%40b.com'
    !>  (form-body:http ~[['mode' 'payment'] ['customer_email' 'a@b.com']])
::
++  test-form-body-space-is-plus
  ::  application/x-www-form-urlencoded spells a space +, and iris
  ::  mangles a %20 inside a url it is given: the far end answers 400.
  ::  A real + in a value still has to be encoded.
  ;:  weld
    (expect-eq !>('q=Penman+Road') !>((form-body:http ~[['q' 'Penman Road']])))
    (expect-eq !>('q=a%2Bb') !>((form-body:http ~[['q' 'a+b']])))
    ::  and a path is not a form body: there a space is still %20
    (expect-eq !>('a%20b') !>((url-encode:http 'a b')))
  ==
::
++  test-form-body-one-key
  %+  expect-eq
    !>  'mode=payment'
    !>  (form-body:http ~[['mode' 'payment']])
::
++  test-form-body-empty
  %+  expect-eq
    !>  ''
    !>  (form-body:http ~)
::
++  test-bearer
  %+  expect-eq
    !>  'Bearer sk_test_1'
    !>  (bearer:http 'sk_test_1')
--
