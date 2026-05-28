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
::
::  ── web reader (server-rendered HTML) ──
::
++  test-esc
  (expect-eq !>("a&lt;b&gt;&amp;&quot;") !>((esc "a<b>&\"")))
::
++  test-foreign-scheme
  ;:  weld
    (expect-eq !>(&) !>((foreign-scheme "https://example.com")))
    (expect-eq !>(&) !>((foreign-scheme "mailto:a@b")))
    (expect-eq !>(|) !>((foreign-scheme "/a/b")))
    (expect-eq !>(|) !>((foreign-scheme "notes/intro")))
    (expect-eq !>(|) !>((foreign-scheme "urb://~zod/a")))
  ==
::
++  test-normalize-tape
  ;:  weld
    (expect-eq !>("/a/c") !>((normalize-tape "/a/b/../c")))
    (expect-eq !>("/a/b") !>((normalize-tape "/a/./b")))
    (expect-eq !>("/x") !>((normalize-tape "/a/../x")))
  ==
::
++  test-urb-of
  ;:  weld
    (expect-eq !>("urb://~zod/a/b") !>((urb-of ~zod /a/b)))
    (expect-eq !>("urb://~zod/") !>((urb-of ~zod ~)))
  ==
::
::  +resolve-href mirrors gemtext/UrbUrl.kt: absolute urb:// pass-through, an
::  absolute /path against the current ship, a relative link against the current
::  dir (with ../. normalized), and ~ for foreign/web links.
++  test-resolve-href
  ;:  weld
    (expect-eq !>("urb://~tyr/x") !>((need (resolve-href "urb://~zod/a/b" "urb://~tyr/x"))))
    (expect-eq !>("urb://~zod/index") !>((need (resolve-href "urb://~zod/notes/ok" "/index"))))
    (expect-eq !>("urb://~zod/notes/intro") !>((need (resolve-href "urb://~zod/notes/ok" "intro"))))
    (expect-eq !>("urb://~zod/a/x") !>((need (resolve-href "urb://~zod/a/b/c" "../x"))))
    (expect-eq !>(&) !>(=(~ (resolve-href "urb://~zod/a" "https://example.com"))))
    (expect-eq !>(&) !>(=(~ (resolve-href "urb://~zod/a" "mailto:a@b"))))
  ==
::
++  test-render-gmi-html
  =/  hdr=tape  (render-gmi-html "urb://~zod/" '# Title')
  =/  lnk=tape  (render-gmi-html "urb://~zod/" '=> /x  Go')
  =/  txt=tape  (render-gmi-html "urb://~zod/" 'a <b> here')
  ;:  weld
    (expect-eq !>(&) !>(!=(~ (find "<h1>Title</h1>" hdr))))
    (expect-eq !>(&) !>(!=(~ (find "<a href=\"/apps/lattice?url=urb://~zod/x\">Go</a>" lnk))))
    (expect-eq !>(&) !>(!=(~ (find "&lt;b&gt;" txt))))
  ==
::
++  test-know-key
  ;:  weld
    (expect-eq !>(`path`/a/b) !>((need (know-key 'a/b'))))
    (expect-eq !>(`path`/a/b) !>((need (know-key '/a/b'))))
    ::  a key with a space isn't a valid path-like key
    (expect-eq !>(&) !>(=(~ (know-key 'a b'))))
  ==
::
::  +do-know: save → live; del → SOFT (moves to recoverable trash, not gone);
::  restore → back to live. This is the delete gate.
++  test-do-know
  =/  st1  (do-know ~2026.1.1 [%save '/a/b' 'hi'] *state-9)
  =/  st2  (do-know ~2026.1.1 [%del '/a/b'] st1)
  =/  st3  (do-know ~2026.1.1 [%restore '/a/b'] st2)
  ;:  weld
    (expect-eq !>('hi') !>(body:(need (~(get by know.st1) /a/b))))
    ::  del removed it from live but kept it in trash (recoverable)
    (expect-eq !>(&) !>(=(~ (~(get by know.st2) /a/b))))
    (expect-eq !>('hi') !>(body:(need (~(get by trash.st2) /a/b))))
    ::  restore brought it back to live
    (expect-eq !>('hi') !>(body:(need (~(get by know.st3) /a/b))))
  ==
::
::  tags: %tag adds (normalized lower-case), %untag removes, %save preserves them,
::  and they survive a del→restore round-trip.
++  test-do-know-tags
  =/  now  ~2026.1.1
  =/  st1  (do-know now [%save '/k' 'b'] *state-9)
  =/  st2  (do-know now [%tag '/k' 'Urbit'] st1)
  =/  st3  (do-know now [%tag '/k' 'design'] st2)
  =/  st4  (do-know now [%save '/k' 'b2'] st3)
  =/  st5  (do-know now [%untag '/k' 'design'] st4)
  =/  st6  (do-know now [%del '/k'] st5)
  =/  st7  (do-know now [%restore '/k'] st6)
  ;:  weld
    ::  fresh save → no tags
    (expect-eq !>(*(set @t)) !>(tags:(need (~(get by know.st1) /k))))
    ::  %tag normalizes Urbit → urbit
    (expect-eq !>((sy ~['urbit'])) !>(tags:(need (~(get by know.st2) /k))))
    (expect-eq !>((sy ~['design' 'urbit'])) !>(tags:(need (~(get by know.st3) /k))))
    ::  %save updates the body but preserves tags
    (expect-eq !>('b2') !>(body:(need (~(get by know.st4) /k))))
    (expect-eq !>((sy ~['design' 'urbit'])) !>(tags:(need (~(get by know.st4) /k))))
    ::  %untag removes one
    (expect-eq !>((sy ~['urbit'])) !>(tags:(need (~(get by know.st5) /k))))
    ::  tags survive del→restore
    (expect-eq !>((sy ~['urbit'])) !>(tags:(need (~(get by trash.st6) /k))))
    (expect-eq !>((sy ~['urbit'])) !>(tags:(need (~(get by know.st7) /k))))
  ==
::
++  test-norm-tag
  ;:  weld
    (expect-eq !>(`@t`'urbit') !>((norm-tag 'Urbit')))
    (expect-eq !>(`@t`'foo bar') !>((norm-tag 'FOO BAR')))
  ==
::
::  +migrate-8-9: head becomes %9, all data carried forward, oquery starts empty.
++  test-migrate-8-9
  =/  e=know-entry  ['body' ~2026.1.1 (sy ~['x']) ~]
  =/  s8=state-8  *state-8
  =.  know.s8   (malt ~[[`path`/a/b e]])
  =.  home.s8   `@uvH`42
  =/  s9=state-9  (migrate-8-9 s8)
  ;:  weld
    (expect-eq !>(%9) !>(-.s9))
    (expect-eq !>(e) !>((~(got by know.s9) /a/b)))
    (expect-eq !>(`@uvH`42) !>(home.s9))
    (expect-eq !>(*(unit [eid=@ta deadline=@da])) !>(oquery.s9))
  ==
::
::  ── explore / discovery (synchronous filter over the live store) ──
++  test-split-on
  ;:  weld
    (expect-eq !>(`(list tape)`~["a" "b" "c"]) !>((split-on ',' "a,b,c")))
    ::  empty segments (leading/trailing/double commas) are dropped
    (expect-eq !>(`(list tape)`~["a" "b"]) !>((split-on ',' ",a,,b,")))
    (expect-eq !>(`(list tape)`~) !>((split-on ',' "")))
    (expect-eq !>(`(list tape)`~["solo"]) !>((split-on ',' "solo")))
  ==
::
++  test-parse-tags
  ;:  weld
    (expect-eq !>((sy ~['urbit' 'design'])) !>((parse-tags 'Urbit,DESIGN')))
    (expect-eq !>(*(set @t)) !>((parse-tags '')))
  ==
::
::  +know-explore: AND/OR tag filter + case-insensitive text search over key/body.
++  test-know-explore
  =/  now  ~2026.1.1
  =/  s0   *state-9
  =/  s1   (do-know now [%save '/notes/urbit-design' 'a note about Hoon'] s0)
  =/  s2   (do-know now [%tag '/notes/urbit-design' 'urbit'] s1)
  =/  s3   (do-know now [%tag '/notes/urbit-design' 'design'] s2)
  =/  s4   (do-know now [%save '/notes/cooking' 'pasta recipe'] s3)
  =/  s5   (do-know now [%tag '/notes/cooking' 'design'] s4)
  =/  st   s5
  ::  ANY of {urbit,design} → both entries (cooking has design)
  =/  any-ud  (know-explore know.st (sy ~['urbit' 'design']) | '')
  ::  ALL of {urbit,design} → only the urbit-design note
  =/  all-ud  (know-explore know.st (sy ~['urbit' 'design']) & '')
  ::  text query on body (case-insensitive)
  =/  q-hoon  (know-explore know.st *(set @t) | 'HOON')
  ::  text query on the key
  =/  q-cook  (know-explore know.st *(set @t) | 'cooking')
  ::  no filters → everything
  =/  q-none  (know-explore know.st *(set @t) | '')
  ;:  weld
    (expect-eq !>(2) !>(~(wyt by any-ud)))
    (expect-eq !>(1) !>(~(wyt by all-ud)))
    (expect-eq !>(&) !>((~(has by all-ud) /notes/urbit-design)))
    (expect-eq !>(1) !>(~(wyt by q-hoon)))
    (expect-eq !>(&) !>((~(has by q-hoon) /notes/urbit-design)))
    (expect-eq !>(1) !>(~(wyt by q-cook)))
    (expect-eq !>(&) !>((~(has by q-cook) /notes/cooking)))
    (expect-eq !>(2) !>(~(wyt by q-none)))
  ==
::
::  ── obelisk index mirror (urQL string builders; obelisk itself not required) ──
++  test-obelisk-create-urql
  =/  s=tape  obelisk-create-urql
  ;:  weld
    (expect-eq !>(&) !>(!=(~ (find "CREATE DATABASE lattice;" s))))
    (expect-eq !>(&) !>(!=(~ (find "CREATE TABLE knowledge (item @t, updated @da) PRIMARY KEY (item);" s))))
    (expect-eq !>(&) !>(!=(~ (find "CREATE TABLE tags (item @t, tag @t) PRIMARY KEY (item, tag);" s))))
  ==
::
++  test-obelisk-row-urql
  =/  e=know-entry  ['body' ~2026.1.1 (sy ~['urbit' 'design']) ~]
  =/  s=tape  (obelisk-row-urql "/a/b" e)
  ;:  weld
    (expect-eq !>(&) !>(!=(~ (find "INSERT INTO knowledge (item, updated) VALUES ('/a/b', ~2026.1.1);" s))))
    (expect-eq !>(&) !>(!=(~ (find "INSERT INTO tags (item, tag) VALUES ('/a/b', 'urbit');" s))))
    (expect-eq !>(&) !>(!=(~ (find "INSERT INTO tags (item, tag) VALUES ('/a/b', 'design');" s))))
  ==
::
++  test-obelisk-populate-urql
  =/  st  (do-know ~2026.1.1 [%save '/a/b' 'hi'] *state-9)
  =/  s=tape  (obelisk-populate-urql know.st)
  ;:  weld
    ::  clears both tables before re-inserting (full rebuild)
    (expect-eq !>(&) !>(!=(~ (find "TRUNCATE TABLE knowledge;TRUNCATE TABLE tags;" s))))
    (expect-eq !>(&) !>(!=(~ (find "INSERT INTO knowledge (item, updated) VALUES ('/a/b'," s))))
  ==
::
::  +mirror-urql: incremental per-action index update. save/restore = clear the
::  item then re-insert it; del = clear it (never insert); tag/untag = touch the
::  one tag row; bad/no-op key = empty.
++  test-mirror-urql
  =/  now  ~2026.1.1
  =/  st1  (do-know now [%save '/a/b' 'hi'] *state-9)
  =/  st2  (do-know now [%tag '/a/b' 'urbit'] st1)
  =/  m-save   (mirror-urql [%save '/a/b' 'hi'] st1)
  =/  st-del   (do-know now [%del '/a/b'] st2)
  =/  m-del    (mirror-urql [%del '/a/b'] st-del)
  =/  m-tag    (mirror-urql [%tag '/a/b' 'Urbit'] st2)
  =/  m-untag  (mirror-urql [%untag '/a/b' 'urbit'] st2)
  =/  m-noop   (mirror-urql [%save 'bad key' 'x'] *state-9)
  ;:  weld
    ::  save = delete the stale row, then insert the current one
    (expect-eq !>(&) !>(!=(~ (find "DELETE FROM knowledge WHERE item = '/a/b';" m-save))))
    (expect-eq !>(&) !>(!=(~ (find "INSERT INTO knowledge (item, updated) VALUES ('/a/b'," m-save))))
    ::  del removes the item + its tags and never inserts
    (expect-eq !>(&) !>(!=(~ (find "DELETE FROM knowledge WHERE item = '/a/b';" m-del))))
    (expect-eq !>(&) !>(!=(~ (find "DELETE FROM tags WHERE item = '/a/b';" m-del))))
    (expect-eq !>(&) !>(=(~ (find "INSERT" m-del))))
    ::  tag normalizes (Urbit→urbit) and replaces just that one pair
    (expect-eq !>(&) !>(!=(~ (find "DELETE FROM tags WHERE item = '/a/b' AND tag = 'urbit';" m-tag))))
    (expect-eq !>(&) !>(!=(~ (find "INSERT INTO tags (item, tag) VALUES ('/a/b', 'urbit');" m-tag))))
    ::  untag deletes the one pair, no insert
    (expect-eq !>(&) !>(!=(~ (find "DELETE FROM tags WHERE item = '/a/b' AND tag = 'urbit';" m-untag))))
    (expect-eq !>(&) !>(=(~ (find "INSERT" m-untag))))
    ::  an invalid/no-op key mirrors nothing
    (expect-eq !>("") !>(m-noop))
  ==
::
++  test-render-home
  =/  h=tape  (trip (render-home "urb://~zod/" "urb://~zod/" '# Home'))
  ;:  weld
    (expect-eq !>(&) !>(!=(~ (find "<h1>Home</h1>" h))))
    (expect-eq !>(&) !>(!=(~ (find "native app" h))))
    (expect-eq !>(&) !>(!=(~ (find "https://lattice.nisfeb.com" h))))
  ==
::
++  test-safe-ext
  ;:  weld
    (expect-eq !>(&) !>((safe-ext "https://example.com")))
    (expect-eq !>(&) !>((safe-ext "http://example.com")))
    (expect-eq !>(&) !>((safe-ext "mailto:a@b")))
    (expect-eq !>(|) !>((safe-ext "javascript:alert(1)")))
    (expect-eq !>(|) !>((safe-ext "data:text/html,x")))
  ==
::
::  SECURITY: a hostile page's javascript:/data: link must NOT become a clickable
::  href in the (authenticated, same-origin) reader. A safe http link must.
++  test-render-link-schemes
  =/  js=tape   (render-gmi-html "urb://~zod/" '=> javascript:alert(1)  pwn')
  =/  web=tape  (render-gmi-html "urb://~zod/" '=> https://example.com  site')
  ;:  weld
    (expect-eq !>(&) !>(=(~ (find "<a " js))))
    (expect-eq !>(&) !>(=(~ (find "javascript" js))))
    (expect-eq !>(&) !>(!=(~ (find "pwn" js))))
    (expect-eq !>(&) !>(!=(~ (find "<a href=\"https://example.com\" target=\"_blank\" rel=\"noopener noreferrer\">site</a>" web))))
  ==
::
::  +obelisk-result-json: decode obelisk's raw %noun query result. Success →
::  {ok:true, columns, rows, count, relation}; [%.n tang] → {ok:false, error}.
++  test-obelisk-result-json
  =/  vec=ob-vector  [%vector ~[[`@tas`'item' 't' 'hi'] [`@tas`'updated' 'da' ~2026.1.1]]]
  =/  good=(list ob-cmd-result)
    ~[[%results ~[[%result-set ~[vec]] [%relation 'lattice.dbo.knowledge'] [%vector-count 1]]]]
  =/  okj=tape  (trip (en:json:html (obelisk-result-json [%.y good])))
  =/  erj=tape  (trip (en:json:html (obelisk-result-json [%.n `tang`~[leaf+"boom"]])))
  ;:  weld
    (expect-eq !>(&) !>(!=(~ (find "\"ok\":true" okj))))
    (expect-eq !>(&) !>(!=(~ (find "\"columns\":[\"item\",\"updated\"]" okj))))
    ::  text auras render raw (not scot-escaped): the cell value is "hi"
    (expect-eq !>(&) !>(!=(~ (find "\"hi\"" okj))))
    (expect-eq !>(&) !>(!=(~ (find "\"count\":1" okj))))
    (expect-eq !>(&) !>(!=(~ (find "lattice.dbo.knowledge" okj))))
    (expect-eq !>(&) !>(!=(~ (find "\"ok\":false" erj))))
    (expect-eq !>(&) !>(!=(~ (find "boom" erj))))
  ==
::  a SELECT with zero rows → ok, empty columns/rows, count 0.
++  test-obelisk-result-empty
  =/  res=(list ob-cmd-result)
    ~[[%results ~[[%action 'SELECT'] [%result-set ~] [%vector-count 0]]]]
  =/  j=tape  (trip (en:json:html (obelisk-result-json [%.y res])))
  ;:  weld
    (expect-eq !>(&) !>(!=(~ (find "\"ok\":true" j))))
    (expect-eq !>(&) !>(!=(~ (find "\"columns\":[]" j))))
    (expect-eq !>(&) !>(!=(~ (find "\"rows\":[]" j))))
    (expect-eq !>(&) !>(!=(~ (find "\"count\":0" j))))
  ==
::  a write (INSERT/DELETE/TRUNCATE) returns %action with NO %result-set: ok,
::  the action echoed, empty table.
++  test-obelisk-result-write
  =/  res=(list ob-cmd-result)
    ~[[%results ~[[%action 'INSERT INTO knowledge'] [%vector-count 1]]]]
  =/  j=tape  (trip (en:json:html (obelisk-result-json [%.y res])))
  ;:  weld
    (expect-eq !>(&) !>(!=(~ (find "\"ok\":true" j))))
    (expect-eq !>(&) !>(!=(~ (find "INSERT INTO knowledge" j))))
    (expect-eq !>(&) !>(!=(~ (find "\"columns\":[]" j))))
    (expect-eq !>(&) !>(!=(~ (find "\"count\":1" j))))
  ==
::  a result whose vector has an empty (illegal) cell list fails the clam — the
::  +mule wrapper must yield an error object, NOT crash the agent.
++  test-obelisk-result-malformed
  =/  bad=*  [%.y ~[[%results ~[[%result-set ~[[%vector ~]]]]]]]
  =/  j=tape  (trip (en:json:html (obelisk-result-json bad)))
  (expect-eq !>(&) !>(!=(~ (find "\"ok\":false" j))))
::  non-text auras render via +scot (a ud count → "5"); text columns stay raw.
++  test-obelisk-result-aura
  =/  vec=ob-vector  [%vector ~[[`@tas`'item' 't' 'k'] [`@tas`'n' 'ud' 5]]]
  =/  res=(list ob-cmd-result)  ~[[%results ~[[%result-set ~[vec]]]]]
  =/  j=tape  (trip (en:json:html (obelisk-result-json [%.y res])))
  ;:  weld
    (expect-eq !>(&) !>(!=(~ (find "\"k\"" j))))
    (expect-eq !>(&) !>(!=(~ (find "\"5\"" j))))
  ==
--
