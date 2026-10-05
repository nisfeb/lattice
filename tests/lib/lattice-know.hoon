::  Unit tests for /lib/lattice-know (pure vault helpers).  Run with:
::    -test %/tests/lib/lattice-know ~   (or the run-tests MCP tool)
::
/+  *test, *lattice-know
|%
++  base  `path`/lattice/know/vault
::  Every key maps to [base+key %entry]: the storage layout the vault uses.
::
++  test-key-to-rail
  ;:  weld
    (expect-eq !>(`vrail`[/lattice/know/vault/projects/x %entry]) !>((key-to-rail base /projects/x)))
    ::  empty key -> the `entry` file directly under the vault root
    (expect-eq !>(`vrail`[/lattice/know/vault %entry]) !>((key-to-rail base ~)))
    ::  prefix coexistence: /a and /a/b are distinct leaves, neither inside
    ::  the other's entry
    (expect-eq !>(`vrail`[/lattice/know/vault/a %entry]) !>((key-to-rail base /a)))
    (expect-eq !>(`vrail`[/lattice/know/vault/a/b %entry]) !>((key-to-rail base /a/b)))
  ==
::  sample entries for derivation tests.
::
++  e1  ^-  know-entry  ['hello' ~2026.1.1 (sy ~['ai' 'notes']) ~]
++  e2  ^-  know-entry  ['hi' ~2026.2.2 ~ ~]
::  +to-index-entry drops the body, keeping updated/bytes/tags; bytes = (met 3).
::
++  test-to-index-entry
  ;:  weld
    (expect-eq !>(`index-entry`[~2026.1.1 5 (sy ~['ai' 'notes']) ~]) !>((to-index-entry e1)))
    (expect-eq !>(`index-entry`[~2026.2.2 2 ~ ~]) !>((to-index-entry e2)))
  ==
::  +merge-save: new key -> [body now ~ ~]; existing -> keep tags+vector,
::  bump body+updated.
::
++  test-merge-save
  ;:  weld
    (expect-eq !>(`know-entry`['new' ~2026.3.3 ~ ~]) !>((merge-save ~ 'new' ~2026.3.3)))
    %+  expect-eq
      !>(`know-entry`['edit' ~2026.3.3 (sy ~['ai' 'notes']) ~])
    !>((merge-save `e1 'edit' ~2026.3.3))
  ==
::  +add-tag / +del-tag: only the tag set changes; idempotent.
::
++  test-tagging
  ;:  weld
    (expect-eq !>(`know-entry`['hi' ~2026.2.2 (sy ~['x']) ~]) !>((add-tag e2 'x')))
    ::  adding an existing tag is a no-op
    (expect-eq !>(e1) !>((add-tag e1 'ai')))
    (expect-eq !>(`know-entry`['hello' ~2026.1.1 (sy ~['notes']) ~]) !>((del-tag e1 'ai')))
    ::  deleting an absent tag is a no-op
    (expect-eq !>(e2) !>((del-tag e2 'nope')))
  ==
::  ==  recall
::
::  +terms: lower-cased, split on punctuation, a compound kept whole AND as
::  its parts, stop words and one-letter words gone, then stemmed.
++  test-terms
  ;:  weld
    %+  expect-eq
      !>(`(list @t)`~['release' 'ricsul-bilwyt' 'ricsul' 'bilwyt' 'ship'])
    !>((terms 'Releases of ~ricsul-bilwyt, the Ship!'))
    ::  a key reads as its whole path and its segments
    (expect-eq !>(`(list @t)`~['user/ai-model' 'user' 'ai' 'model']) !>((terms '/user/ai-models')))
    (expect-eq !>(`(list @t)`~) !>((terms 'a I of the -- ~')))
  ==
++  test-stem
  ;:  weld
    (expect-eq !>("follow") !>((stem "following")))
    (expect-eq !>("follow") !>((stem "follows")))
    (expect-eq !>("class") !>((stem "classes")))
    (expect-eq !>("policy") !>((stem "policies")))
    (expect-eq !>("status") !>((stem "status")))
    (expect-eq !>("glass") !>((stem "glass")))
    (expect-eq !>("ship") !>((stem "ship")))
    (expect-eq !>("used") !>((stem "used")))
  ==
::  +front / +with-front: front matter round-trips byte for byte, and a body
::  without it passes through.
++  test-front
  =/  b=@t  '---\0aauthor: lattice-53\0asource: user\0a---\0aHello\0a'
  =/  f  (front b)
  ;:  weld
    (expect-eq !>(`(list [@t @t])`~[['author' 'lattice-53'] ['source' 'user']]) !>(meta.f))
    (expect-eq !>('Hello\0a') !>(rest.f))
    (expect-eq !>(b) !>((with-front meta.f rest.f)))
    (expect-eq !>([`(list [k=@t v=@t])`~ 'plain']) !>((front 'plain')))
    ::  an unclosed fence is not front matter
    (expect-eq !>(`(list [k=@t v=@t])`~) !>(meta:(front '---\0aa: b\0ano close')))
    (expect-eq !>('x') !>((with-front ~ 'x')))
  ==
++  test-meta
  =/  m=(list [k=@t v=@t])  ~[['a' '1'] ['b' '2']]
  ;:  weld
    (expect-eq !>(`(unit @t)``'2') !>((meta-get m 'b')))
    (expect-eq !>(`(unit @t)`~) !>((meta-get m 'c')))
    (expect-eq !>(`(list [k=@t v=@t])`~[['a' '9'] ['b' '2']]) !>((meta-put m 'a' '9')))
    (expect-eq !>(`(list [k=@t v=@t])`~[['a' '1'] ['b' '2'] ['c' '3']]) !>((meta-put m 'c' '3')))
    (expect-eq !>(`(list [k=@t v=@t])`~[['b' '2']]) !>((meta-put m 'a' '')))
  ==
++  test-links
  ;:  weld
    %+  expect-eq  !>(`(list path)`~[/user/x /project/y])
    !>((links 'see [[user/x]] and [[/project/y|Y]], [[user/x]] again, [[Bad Key]]'))
    (expect-eq !>(`(list path)`~) !>((links 'no links [[unclosed')))
  ==
++  test-lg2m
  =/  l3=@ud  (lg2m 3 1)
  ;:  weld
    (expect-eq !>(3.000) !>((lg2m 8 1)))
    (expect-eq !>(1.000) !>((lg2m 6 3)))
    ::  log2 3 = 1.58496, to the fixed point's last bit
    (expect-eq !>(&) !>(&((gte l3 1.583) (lte l3 1.585))))
    (expect-eq !>(0) !>((lg2m 1 1)))
    (expect-eq !>(0) !>((lg2m 1 3)))
    (expect-eq !>(0) !>((lg2m 5 0)))
  ==
::  +rank: only docs with a query term, best first; a doc with every term
::  carries all the query's IDF, so strength 100.
++  test-rank
  =/  ds=(list doc)
    :~  (to-doc /user/x ['alpha beta' ~2026.1.1 ~ ~])
        (to-doc /p/y ['beta gamma gamma' ~2026.1.1 ~ ~])
        (to-doc /p/z ['delta' ~2026.1.1 ~ ~])
    ==
  =/  bg=(list hit)  (rank ds 'beta gamma')
  ;:  weld
    (expect-eq !>(`(list path)`~[/p/y]) !>((turn (rank ds 'gamma') |=(h=hit key.h))))
    (expect-eq !>(`(list path)`~[/p/y /user/x]) !>((turn bg |=(h=hit key.h))))
    (expect-eq !>(100) !>(?~(bg 0 strength.i.bg)))
    (expect-eq !>(&) !>(?.(?=([* * ~] bg) | (lth strength.i.t.bg 100))))
    (expect-eq !>(`(list hit)`~) !>((rank ds 'nothing here')))
    (expect-eq !>(`(list hit)`~) !>((rank ~ 'beta')))
    ::  front matter is not ranked
    %+  expect-eq  !>(`(list hit)`~)
    !>((rank ~[(to-doc /a ['---\0aauthor: zeta\0a---\0abody' ~2026.1.1 ~ ~])] 'zeta'))
  ==
++  test-snippet
  =/  long=@t  (crip (weld (reap 300 'x') " gamma tail"))
  =/  s=@t  (snippet long 'gamma')
  ;:  weld
    %+  expect-eq  !>('the gamma line')
    !>((snippet '---\0aa: b\0a---\0afirst line\0athe gamma line\0alast' 'gamma'))
    ::  no line carries a term: the first line
    (expect-eq !>('first') !>((snippet 'first\0asecond' 'zeta')))
    (expect-eq !>(&) !>(&(?=(^ (find "gamma" (trip s))) (lte (met 3 s) 206))))
    (expect-eq !>("...") !>((scag 3 (trip s))))
  ==
++  test-utf8-trims
  ;:  weld
    (expect-eq !>("a") !>((drop-cont ~[`@tD`0x80 `@tD`0xbf 'a'])))
    (expect-eq !>("ab") !>((flop (drop-high (flop ~['a' 'b' `@tD`0xc3 `@tD`0xa9])))))
  ==
++  test-overlap
  ;:  weld
    (expect-eq !>(50) !>((overlap (sy ~['a' 'b' 'c']) (sy ~['b' 'c' 'd']))))
    (expect-eq !>(0) !>((overlap ~ ~)))
    (expect-eq !>(100) !>((overlap (term-set 'alpha beta') (term-set '---\0ax: y\0a---\0abeta alpha'))))
  ==
::  +search: a superseded entry is left out unless asked for; a quoted
::  query must appear verbatim.
++  test-search
  =/  es=(list [key=path e=know-entry])
    :~  [/a ['alpha beta' ~2026.1.1 ~ ~]]
        [/b ['---\0asuperseded-by: /a\0a---\0aalpha gamma' ~2026.1.1 ~ ~]]
        [/c ['beta then alpha' ~2026.1.1 ~ ~]]
    ==
  =/  keys  |=(hs=(list hit) (sort (turn hs |=(h=hit key.h)) aor))
  ;:  weld
    (expect-eq !>(`(list path)`~[/a /c]) !>((keys (search es ~ 'alpha' |))))
    (expect-eq !>(`(list path)`~[/a /b /c]) !>((keys (search es ~ 'alpha' &))))
    (expect-eq !>(`(list path)`~[/a]) !>((keys (search es ~ '"Alpha Beta"' |))))
    (expect-eq !>(`(unit @t)``'/a') !>((superseded e:(snag 1 es))))
  ==
::  the term cache: a current row is used as is, a stale or missing one is
::  recomputed, and refresh drops rows for entries that are gone
++  test-term-cache
  =/  e1=know-entry  ['alpha beta' ~2026.1.1 ~ ~]
  =/  e2=know-entry  ['gamma' ~2026.1.1 ~ ~]
  =/  bogus=term-row  [~2026.1.1 ~ [/a (my ~[['zeta' 1]]) 1]]
  =/  tc=term-cache  (my ~[[/a bogus] [/gone (row-of /gone e2)]])
  =/  r  (refresh ~[[/a e1] [/b e2]] tc)
  ;:  weld
    ::  /a's row is current by updated and tags, so search believes it
    (expect-eq !>(`(list path)`~[/a]) !>((turn (search ~[[/a e1]] tc 'zeta' |) |=(h=hit key.h))))
    ::  edited since: the row is stale and the entry is read again
    (expect-eq !>(`(list hit)`~) !>((search ~[[/a e1(updated ~2026.2.2)]] tc 'zeta' |)))
    (expect-eq !>(&) !>(chg.r))
    (expect-eq !>(`(list path)`~[/a /b]) !>((sort ~(tap in ~(key by tc.r)) aor)))
    (expect-eq !>(bogus) !>((~(got by tc.r) /a)))
  ==
++  test-near
  =/  es=(list [key=path e=know-entry])
    :~  [/a ['zebra quokka narwhal axolotl pangolin' ~2026.1.1 ~ ~]]
        [/b ['completely unrelated words here' ~2026.1.1 ~ ~]]
    ==
  =/  tc=term-cache  (malt (turn es |=([k=path e=know-entry] [k (row-of k e)])))
  ;:  weld
    (expect-eq !>(`(list path)`~[/a]) !>((turn (near es tc 'zebra quokka narwhal axolotl okapi') |=([* k=path] k))))
    (expect-eq !>(`(list path)`~[/a]) !>((turn (near es ~ 'zebra quokka narwhal axolotl okapi') |=([* k=path] k))))
    (expect-eq !>(`(list [@ud path])`~) !>((near es tc 'nothing alike at all')))
  ==
++  test-lint
  =/  es=(list [key=path e=know-entry])
    :~  [/a ['see [[b]] and [[missing]]' ~2026.2.28 ~ ~]]
        [/b ['x' ~2026.2.28 (sy ~['t']) ~]]
        [/c ['---\0asuperseded-by: /nope\0a---\0afix foo.hoon' ~2026.1.1 ~ ~]]
        [/d ['---\0averified: 2026-02-27\0a---\0asee app.hoon' ~2026.1.1 (sy ~['t']) ~]]
    ==
  =/  l=lint  (lint-run es ~2026.3.1)
  ;:  weld
    (expect-eq !>(`(list [path path])`~[[/a /missing]]) !>(broken.l))
    (expect-eq !>(`(list [path @t])`~[[/c '/nope']]) !>(bad-super.l))
    ::  /c is superseded, so resolved: only its broken supersede link counts
    (expect-eq !>(`(list path)`~[/a]) !>(untagged.l))
    ::  /d was verified two days ago; /c would be stale but is superseded
    (expect-eq !>(`(list [path @ud])`~) !>(stale.l))
    (expect-eq !>(`(list path)`~[/d]) !>(orphans.l))
    (expect-eq !>(`(list [path path @ud])`~) !>(dups.l))
  ==
++  test-lint-dups
  =/  body=@t  'zebra quokka narwhal axolotl pangolin okapi tapir dugong'
  =/  es=(list [key=path e=know-entry])
    :~  [/old [body ~2026.1.1 ~ ~]]
        [/new [(cat 3 body ' plus') ~2026.1.1 ~ ~]]
        [/other ['something else entirely different' ~2026.1.1 ~ ~]]
    ==
  =/  l=lint  (lint-run es ~2026.1.2)
  ::  once one copy is superseded, the pair is resolved and not proposed
  =/  done=lint
    %+  lint-run
      (turn es |=([k=path e=know-entry] ?.(=(k /old) [k e] [k e(body (cat 3 '---\0asuperseded-by: /new\0a---\0a' body.e))])))
    ~2026.1.2
  ;:  weld
    (expect-eq !>(`(list [path path])`~[[/new /old]]) !>((turn dups.l |=([a=path b=path *] [a b]))))
    (expect-eq !>(`(list [path path @ud])`~) !>(dups.done))
  ==
++  test-iso-day
  ;:  weld
    (expect-eq !>('2026-10-03') !>((iso-day ~2026.10.3..14.05.11)))
    (expect-eq !>(`(unit @da)``~2026.10.3) !>((from-iso-day '2026-10-03')))
    (expect-eq !>(`(unit @da)`~) !>((from-iso-day '2026-13-01')))
    (expect-eq !>(`(unit @da)`~) !>((from-iso-day 'soon')))
  ==
::  the session index: areas, then core rules up to the cap
++  test-index-text
  =/  es=(map path know-entry)
    %-  malt
    ^-  (list [path know-entry])
    :~  [/feedback/a ['rule one' ~2026.1.1 (sy 'core' ~) ~]]
        [/feedback/b ['a long rule that will not fit' ~2026.1.1 (sy 'core' ~) ~]]
        [/project/x/y ['plain' ~2026.1.1 ~ ~]]
        [/feedback/old ['---\0asuperseded-by: /feedback/a\0a---\0agone' ~2026.1.1 ~ ~]]
    ==
  =/  full=tape  (trip (index-text es | 100))
  =/  brief=tape  (trip (index-text es & 10))
  ;:  weld
    (expect !>(?=(^ (find "feedback (2): a, b" full))))
    (expect !>(?=(^ (find "project/x (1): y" full))))
    (expect !>(?=(~ (find "old" full))))
    (expect !>(?=(^ (find "feedback (2)\0a" brief))))
    (expect !>(?=(~ (find "a, b" brief))))
    (expect !>(?=(^ (find "## /feedback/a\0arule one" brief))))
    (expect !>(?=(^ (find "## /feedback/b (over the cap: read it)" brief))))
  ==
::  a save keeps created, sets author and source, and stamps verified
++  test-stamp
  =/  old=know-entry  ['---\0acreated: 2025-01-02\0aauthor: someone\0a---\0aold fact' ~2026.1.1 ~ ~]
  =/  m  meta:(front (stamp `old 'new fact' 'claude-laptop' 'agent' ~2026.10.4 |))
  ;:  weld
    (expect-eq !>(`(unit @t)``'2025-01-02') !>((meta-get m 'created')))
    (expect-eq !>(`(unit @t)``'claude-laptop') !>((meta-get m 'author')))
    (expect-eq !>(`(unit @t)``'agent') !>((meta-get m 'source')))
    (expect-eq !>(`(unit @t)``'2026-10-04') !>((meta-get m 'verified')))
    (expect-eq !>('new fact') !>(rest:(front (stamp `old 'new fact' '' '' ~2026.10.4 |))))
    (expect-eq !>(`(unit @t)``'2026-10-04') !>((meta-get meta:(front (stamp ~ 'x' '' '' ~2026.10.4 |)) 'created')))
  ==
::  a sensitive entry says so in its front matter; a save can mark or clear it
++  test-sensitive
  =/  plain=know-entry  ['a fact' ~2026.1.1 ~ ~]
  =/  marked=know-entry  ['---\0asensitive: yes\0a---\0aa fact' ~2026.1.1 ~ ~]
  =/  on=@t  (stamp `plain 'a fact' '' '' ~2026.10.4 &)
  =/  off=@t  (stamp `marked 'a fact' '' '' ~2026.10.4 |)
  ;:  weld
    (expect-eq !>(|) !>((sensitive plain)))
    (expect-eq !>(&) !>((sensitive marked)))
    (expect-eq !>(&) !>((sensitive [on ~2026.1.1 ~ ~])))
    (expect-eq !>(|) !>((sensitive [off ~2026.1.1 ~ ~])))
    (expect-eq !>('a fact') !>(rest:(front on)))
  ==
::  recall never links to a sensitive entry, even for a cleared reader
++  test-recall-hides-sensitive-links
  =/  es=(map path know-entry)
    %-  malt
    ^-  (list [path know-entry])
    :~  [/a ['zebra quokka, see [[/b]] and [[/c]]' ~2026.1.1 ~ ~]]
        [/b ['---\0asensitive: yes\0a---\0ahidden' ~2026.1.1 ~ ~]]
        [/c ['shown' ~2026.1.1 ~ ~]]
    ==
  =/  hs  (search ~(tap by es) ~ 'zebra quokka' |)
  =/  out=tape  (trip (en:json:html (recall-json es hs 'zebra quokka' 8)))
  ;:  weld
    (expect !>(?=(^ (find "\"/c\"" out))))
    (expect !>(?=(~ (find "\"/b\"" out))))
  ==
::  a keyed tidy leaves out hidden entries, and a link to one is not broken
++  test-lint-without
  =/  es=(list [key=path e=know-entry])
    :~  [/a ['see [[/h]]' ~2026.1.1 ~ ~]]
        [/h ['---\0asensitive: yes\0a---\0ahidden' ~2026.1.1 ~ ~]]
    ==
  =/  l  (lint-without (lint-run es ~2026.1.2) (sy ~[/h]))
  ;:  weld
    (expect-eq !>(`(list [path path])`~) !>(broken.l))
    (expect-eq !>(|) !>((lien untagged.l |=(k=path =(k /h)))))
    (expect-eq !>(|) !>((lien orphans.l |=(k=path =(k /h)))))
  ==
--
