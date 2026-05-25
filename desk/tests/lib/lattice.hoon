::  Unit tests for /lib/lattice (pure helpers).  Run with:
::    -test %/tests/lib/lattice ~   (or the run-tests MCP tool)
::
/+  *test, *lattice
|%
::  build a minimal inbound-request carrying the given url (path/query helpers)
++  mock-req
  |=  url=@t
  ^-  inbound-request:eyre
  =/  r=inbound-request:eyre  *inbound-request:eyre
  r(url.request url)
::
++  test-parse-urb-url
  ;:  weld
    (expect-eq !>(~zod) !>(ship:(need (parse-urb-url 'urb://~zod/a/b'))))
    (expect-eq !>(`path`/a/b) !>(path:(need (parse-urb-url 'urb://~zod/a/b'))))
    (expect-eq !>(~tyr) !>(ship:(need (parse-urb-url 'urb://~tyr'))))
    (expect-eq !>(&) !>(=(~ (parse-urb-url 'https://example.com'))))
  ==
::
++  test-pub-path
  (expect-eq !>(`path`/pub/notes/idea/gmi) !>((pub-path 'notes/idea')))
::
++  test-keen-path
  ;:  weld
    ::  a specific revision (%ud) — used by revision-following
    (expect-eq !>((welp /g/x/1/lattice//1 /hello)) !>((keen-path (scot %ud 1) /hello)))
    ::  the case segment is taken verbatim (a %da case for latest-fetch)
    (expect-eq !>((welp /g/x/2/lattice//1 /a/b)) !>((keen-path '2' /a/b)))
  ==
::
++  test-req-action
  ;:  weld
    (expect-eq !>('save') !>((req-action (mock-req '/apps/lattice/save?path=x'))))
    (expect-eq !>('list') !>((req-action (mock-req '/apps/lattice/list'))))
    (expect-eq !>('fetch') !>((req-action (mock-req '/apps/lattice/fetch?url=urb://~zod/a'))))
  ==
::
++  test-query-param
  ;:  weld
    (expect-eq !>('x') !>((need (query-param (mock-req '/apps/lattice/save?path=x') 'path'))))
    (expect-eq !>('urb://~zod/a') !>((need (query-param (mock-req '/f?url=urb%3A%2F%2F~zod%2Fa') 'url'))))
    (expect-eq !>(&) !>(=(~ (query-param (mock-req '/apps/lattice/list') 'path'))))
  ==
::
++  test-mark-and-body
  =/  s=tape  (trip (mark-and-body 'gmi' 'hi'))
  ;:  weld
    (expect-eq !>(&) !>(!=(~ (find "\"mark\"" s))))
    (expect-eq !>(&) !>(!=(~ (find "\"gmi\"" s))))
    (expect-eq !>(&) !>(!=(~ (find "\"body\"" s))))
    (expect-eq !>(&) !>(!=(~ (find "\"hi\"" s))))
  ==
::
++  test-generate-index
  =/  want=@t  (of-wain:format ~['# Index' '' 'Files published on this ship:' '' '=> /hello  hello'])
  (expect-eq !>(want) !>((generate-index (sy ~[/pub/hello/gmi]))))
--
