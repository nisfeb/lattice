::  Unit tests for /lib/lattice-link, a shared page moved into your tree.
::  Run with:  -test /=grubbery=/tests/lib/lattice-link ~
::
::  The link caches the host's page. Two promises ride on these helpers:
::  kind is frozen at create (a mounted file is never renamed under an
::  open editor), and a failed read keeps the cache (an offline host does
::  not blank the page).
::
/+  *test, lk=lattice-link
|%
++  base
  ^-  link:lk
  :*  %ship  ~zod  /apps/lattice/page/notes/plan/code  'read'
      %md  'old'  3  3  [& ~2024.1.1]
  ==
::  +refresh: a new body and rev land, the kind does not move.
::
++  test-refresh-keeps-kind
  =/  out=link:lk  (refresh:lk base %gmi 'new body' 7 ~2024.1.2)
  ?>  ?=(%ship -.out)
  ;:  weld
    (expect-eq !>(%md) !>(kind.out))
    (expect-eq !>('new body') !>(body.out))
    (expect-eq !>(7) !>(rev.out))
    (expect-eq !>((met 3 'new body')) !>(size.out))
    (expect-eq !>(&) !>(ok.seen.out))
    (expect-eq !>(`@da`~2024.1.2) !>(at.seen.out))
  ==
::  +fail: the cache survives, only seen says the read failed.
::
++  test-fail-keeps-cache
  =/  out=link:lk  (fail:lk base ~2024.1.3)
  ?>  ?=(%ship -.out)
  ;:  weld
    (expect-eq !>('old') !>(body.out))
    (expect-eq !>(3) !>(rev.out))
    (expect-eq !>(%md) !>(kind.out))
    (expect-eq !>(|) !>(ok.seen.out))
    (expect-eq !>(`@da`~2024.1.3) !>(at.seen.out))
  ==
::  +en-link: the body never goes out in the JSON. It can be large, and
::  tree and dump report size, not content.
::
++  test-en-link-no-body
  =/  j=json  (en-link:lk base)
  ?>  ?=([%o *] j)
  ;:  weld
    (expect-eq !>(|) !>((~(has by p.j) 'body')))
    (expect-eq !>(`s+'~zod') !>((~(get by p.j) 'host')))
    (expect-eq !>(`s+'md') !>((~(get by p.j) 'kind')))
  ==
::  a local link carries only its path.
::
++  test-en-link-local
  %+  expect-eq  !>((pairs:enjs:format ~[local+s+'/a/b']))
  !>((en-link:lk [%local /a/b]))
::  +link-name: the page's own name, not its code grub.
::
++  test-link-name
  ;:  weld
    (expect-eq !>('plan') !>((link-name:lk /apps/lattice/page/notes/plan/code)))
    (expect-eq !>('plan') !>((link-name:lk /apps/lattice/page/notes/plan)))
    (expect-eq !>('') !>((link-name:lk /)))
  ==
::  +after-unsure: an unconfirmed write read back. Only our own text there
::  is a landing whose rev may be cached; a third party's text must leave
::  the cache alone, or the next lick write claims its rev and overwrites
::  it without a 409.
++  test-after-unsure-ours-landed
  %+  expect-eq  !>(%landed)
  !>((after-unsure:lk 'mine' `[%md 'mine' 4]))
++  test-after-unsure-theirs-kept
  %+  expect-eq  !>(%keep)
  !>((after-unsure:lk 'mine' `[%md 'theirs' 4]))
++  test-after-unsure-no-read
  %+  expect-eq  !>(%none)
  !>((after-unsure:lk 'mine' ~))
--
