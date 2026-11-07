::  Unit tests for /lib/lattice-share, the shares inbox and the banlist.
::  Run with:  -test /=grubbery=/tests/lib/lattice-share ~
::
::  The inbox is a list a STRANGER can append to (any ship may poke it), and
::  the banlist is the only thing that can refuse one. Both are pure data, so
::  both are testable without a ship. That matters, because the enforcement
::  points that call them need a second ship to exercise end to end.
::
/+  *test, ls=lattice-share
|%
++  zod  ~zod
++  bus  ~bus
++  nec  ~nec
::  +is-banned: the single predicate every enforcement point calls. If this is
::  wrong, a ban silently does nothing at three different call sites.
::
++  test-is-banned
  =/  bans=banned:ls  (~(gas in *(set @p)) ~[zod bus])
  ;:  weld
    (expect-eq !>(%.y) !>((is-banned:ls bans zod)))
    (expect-eq !>(%.y) !>((is-banned:ls bans bus)))
    (expect-eq !>(%.n) !>((is-banned:ls bans nec)))
    ::  an empty banlist refuses nobody. The default must not be "deny all"
    (expect-eq !>(%.n) !>((is-banned:ls *banned:ls zod)))
  ==
::  +put-entry: a re-share UPDATES rather than duplicating. Without this a
::  hostile ship grows the grub one entry per poke.
::
++  test-put-entry-dedupes
  =/  one=entry:ls  [zod /apps/x 'read' ~2024.1.1]
  =/  two=entry:ls  [zod /apps/x 'edit' ~2024.1.2]
  =/  out=shared:ls  (put-entry:ls (put-entry:ls ~ one) two)
  ;:  weld
    ::  same [host pax] collapses to one entry...
    (expect-eq !>(1) !>((lent out)))
    ::  ...carrying the NEWER mode and time
    (expect-eq !>('edit') !>(mode:(snag 0 out)))
    (expect-eq !>(`@da`~2024.1.2) !>(when:(snag 0 out)))
  ==
::  a different host, or a different path, is a different entry.
::
++  test-put-entry-keys-on-host-and-path
  =/  a=entry:ls  [zod /apps/x 'read' ~2024.1.1]
  =/  b=entry:ls  [bus /apps/x 'read' ~2024.1.1]
  =/  c=entry:ls  [zod /apps/y 'read' ~2024.1.1]
  =/  out=shared:ls  (put-entry:ls (put-entry:ls (put-entry:ls ~ a) b) c)
  ;:  weld
    (expect-eq !>(3) !>((lent out)))
    ::  newest first: the last one put is at the head
    (expect-eq !>(`path`/apps/y) !>(pax:(snag 0 out)))
  ==
::  +cap: the bound is what keeps an append-only list a stranger can write
::  from growing without limit. Overflow drops the OLDEST, never the newest.
::
++  test-put-entry-caps
  =/  many=shared:ls
    =/  i=@ud  0
    =|  acc=shared:ls
    |-  ^-  shared:ls
    ?:  =(i (add cap:ls 25))  acc
    $(i +(i), acc (put-entry:ls acc [zod /apps/[(scot %ud i)] 'read' `@da`(add ~2024.1.1 i)]))
  ;:  weld
    (expect-eq !>(cap:ls) !>((lent many)))
    ::  the most recent survived
    (expect-eq !>(`path`/apps/[(scot %ud (dec (add cap:ls 25)))]) !>(pax:(snag 0 many)))
  ==
::  +del-entry: the owner's own curation, keyed the same way.
::
++  test-del-entry
  =/  a=entry:ls  [zod /apps/x 'read' ~2024.1.1]
  =/  b=entry:ls  [bus /apps/x 'read' ~2024.1.1]
  =/  both=shared:ls  (put-entry:ls (put-entry:ls ~ a) b)
  ;:  weld
    (expect-eq !>(1) !>((lent (del-entry:ls both zod /apps/x))))
    ::  deleting one host leaves the other's entry for the same path alone
    (expect-eq !>(bus) !>(host:(snag 0 (del-entry:ls both zod /apps/x))))
    ::  deleting something absent is a no-op, not a crash
    (expect-eq !>(2) !>((lent (del-entry:ls both nec /apps/zzz))))
  ==
::  the path is half the key: one host's other page survives (hoon-mutate,
::  2026-09-26)
++  test-del-entry-same-host
  =/  a=entry:ls  [zod /apps/x 'read' ~2024.1.1]
  =/  b=entry:ls  [zod /apps/y 'read' ~2024.1.1]
  =/  both=shared:ls  (put-entry:ls (put-entry:ls ~ a) b)
  (expect-eq !>(`(list path)`~[/apps/y]) !>((turn (del-entry:ls both zod /apps/x) |=(e=entry:ls pax.e))))
::  a grant road names a page by its dir, a folder above it, or a file in
::  it. Roads come in as nouns, the shapes tarball gives them.
++  pg  `path`/apps/lat/page/a
++  test-grant-covers-dir-roads
  ;:  weld
    (expect-eq !>(&) !>((grant-covers:ls [%& %| /apps/lat/page/a] pg |)))
    (expect-eq !>(&) !>((grant-covers:ls [%& %| /apps/lat/page] pg |)))
    (expect-eq !>(|) !>((grant-covers:ls [%& %| /apps/lat/page/ab] pg |)))
    (expect-eq !>(|) !>((grant-covers:ls [%& %| /apps/lat/page/a/b] pg |)))
    (expect-eq !>(&) !>((grant-covers:ls [%& %| /apps/lat/page/a/b] pg &)))
  ==
++  test-grant-covers-file-roads
  ;:  weld
    (expect-eq !>(&) !>((grant-covers:ls [%& %& /apps/lat/page/a %code] pg |)))
    (expect-eq !>(&) !>((grant-covers:ls [%& %& /apps/lat/page/a %code] pg &)))
    (expect-eq !>(&) !>((grant-covers:ls [%& %& /apps/lat/page/a/b %code] pg &)))
    (expect-eq !>(|) !>((grant-covers:ls [%& %& /apps/lat/page %a] pg &)))
    (expect-eq !>(|) !>((grant-covers:ls [%& %& /apps/lat/page/b %code] pg &)))
  ==
::  a relative road grants nothing in a group weir, and junk is no road
++  test-grant-covers-other-shapes
  ;:  weld
    (expect-eq !>(|) !>((grant-covers:ls [%| 0 %| /page/a] pg &)))
    (expect-eq !>(|) !>((grant-covers:ls 42 pg &)))
  ==
++  test-grp-name
  ;:  weld
    (expect-eq !>(&) !>((grp-name:ls 'bus.grp')))
    (expect-eq !>(|) !>((grp-name:ls '.grp')))
    (expect-eq !>(|) !>((grp-name:ls 'team')))
  ==
::  a moon answers for its planet, every comet for all comets, and a
::  banned planet's moons are banned with it
++  test-family
  =/  moon=@p  (cat 5 ~sampel-palnet 7)
  ;:  weld
    (expect-eq !>(`@`~sampel-palnet) !>((family:ls ~sampel-palnet)))
    (expect-eq !>(`@`~sampel-palnet) !>((family:ls moon)))
    (expect-eq !>(`@`~zod) !>((family:ls ~zod)))
    (expect-eq !>((bex 128)) !>((family:ls (cat 7 ~sampel-palnet 3))))
    (expect-eq !>(&) !>((is-banned:ls (sy ~[~sampel-palnet]) moon)))
    (expect-eq !>(|) !>((is-banned:ls (sy ~[moon]) ~sampel-palnet)))
  ==
::  in a quota each comet answers for itself, a moon still for its
::  planet; in a ban one comet, or every comet at once
++  test-quota-family
  =/  moon=@p  (cat 5 ~sampel-palnet 7)
  =/  c1=@p  (cat 7 ~sampel-palnet 3)
  =/  c2=@p  (cat 7 ~sampel-palnet 4)
  ;:  weld
    (expect-eq !>(`@`c1) !>((quota-family:ls c1)))
    (expect-eq !>(|) !>(=((quota-family:ls c1) (quota-family:ls c2))))
    (expect-eq !>(`@`~sampel-palnet) !>((quota-family:ls moon)))
    (expect-eq !>(`@`~zod) !>((quota-family:ls ~zod)))
    (expect-eq !>(&) !>((is-banned:ls (sy ~[c1]) c1)))
    (expect-eq !>(|) !>((is-banned:ls (sy ~[c1]) c2)))
    (expect-eq !>(&) !>((is-banned:ls (sy ~[all-comets:ls]) c2)))
    (expect-eq !>(|) !>((is-banned:ls (sy ~[all-comets:ls]) ~sampel-palnet)))
  ==
::  +comet-gate: the comet guard every comet write goes through.
::
++  cg-now  ~2026.11.4..12.00.00
++  cg-comet  `@p`(add (bex 64) 7)
::  ten stamps a minute apart, the newest a minute ago
++  cg-ten
  ^-  (list @da)
  (turn (gulf 1 10) |=(i=@ud (sub cg-now (mul i ~m1))))
++  test-comet-gate-cap
  ;:  weld
    ::  nine in the window: the tenth is taken
    (expect-eq !>([%ok ~]) !>((comet-gate:ls [%open (scag 9 cg-ten)] cg-comet cg-now)))
    ::  ten in the window: the eleventh is refused, with the words
    %+  expect-eq  !>([%refused comet-full-why:ls])
    !>((comet-gate:ls [%open cg-ten] cg-comet cg-now))
    ::  planets and moons are never counted
    (expect-eq !>([%ok ~]) !>((comet-gate:ls [%open cg-ten] ~zod cg-now)))
    (expect-eq !>([%ok ~]) !>((comet-gate:ls [%open cg-ten] ~doznec-sampel-palnet cg-now)))
  ==
++  test-comet-gate-rolls-off
  =/  later=@da  (add cg-now ~m50)
  ;:  weld
    ::  50 minutes on, the oldest stamp (ten minutes before now) has left
    (expect-eq !>([%ok ~]) !>((comet-gate:ls [%open cg-ten] cg-comet later)))
    (expect-eq !>(9) !>((lent (comet-live:ls cg-ten later))))
    ::  and the cap frees when the tenth newest leaves the window
    (expect-eq !>(`(add (sub cg-now ~m10) ~h1)) !>((comet-full-until:ls cg-ten cg-now)))
    (expect-eq !>(~) !>((comet-full-until:ls cg-ten later)))
    ::  stamps an hour old or older count for nothing
    %+  expect-eq  !>([%ok ~])
    !>((comet-gate:ls [%open (turn cg-ten |=(t=@da (sub t ~h1)))] cg-comet cg-now))
  ==
++  test-comet-gate-held
  ;:  weld
    (expect-eq !>([%held ~]) !>((comet-gate:ls [%held ~] cg-comet cg-now)))
    ::  the cap binds a held page too, so the queue is bounded
    %+  expect-eq  !>([%refused comet-full-why:ls])
    !>((comet-gate:ls [%held cg-ten] cg-comet cg-now))
    ::  a planet is never held
    (expect-eq !>([%ok ~]) !>((comet-gate:ls [%held ~] ~zod cg-now)))
  ==
++  test-comet-gate-off
  ;:  weld
    %+  expect-eq  !>([%refused comet-off-why:ls])
    !>((comet-gate:ls [%off ~] cg-comet cg-now))
    (expect-eq !>([%ok ~]) !>((comet-gate:ls [%off ~] ~zod cg-now)))
    ::  a stored mode that will not read is the default
    (expect-eq !>(%open) !>((comet-mode-of:ls 'junk')))
    (expect-eq !>(%held) !>((comet-mode-of:ls %held)))
  ==
++  test-comets-cord
  =/  rows=(map @t comet-row:ls)
    %-  my
    :~  ['/a' [%held ~]]  ['/b/c' [%off ~]]  ['/d' [%open `1.800.000.000]]
        ['/e' [%open ~]]
    ==
  =/  c=@t  (comets-cord:ls rows)
  ;:  weld
    (expect-eq !>((of-wain:format ~['/a held' '/b/c off' '/d open 1800000000'])) !>(c))
    ::  plain open pages are left out, and the rest read back
    (expect-eq !>((~(del by rows) '/e')) !>((comets-rows:ls c)))
    (expect-eq !>(*(map @t comet-row:ls)) !>((comets-rows:ls '')))
    ::  junk lines are dropped, an unknown mode is open
    %+  expect-eq  !>((my ~[['/x' [%open ~]]]))
    !>((comets-rows:ls (of-wain:format ~['/x weird' 'nonsense' ''])))
  ==
::  the whole path a reader sees: ten comets in the hour, the eleventh
::  refused, the page published as full until the cap frees, and open
::  again once the window rolls past
++  test-comet-eleventh-and-roll-off
  =/  until=(unit @da)  (comet-full-until:ls cg-ten cg-now)
  =/  us=@ud  (unix-s:ls (need until))
  ;:  weld
    %+  expect-eq  !>([%refused comet-full-why:ls])
    !>((comet-gate:ls [%open cg-ten] cg-comet cg-now))
    (expect-eq !>(`(add cg-now ~m50)) !>(until))
    (expect-eq !>(50) !>((comet-full-mins:ls us cg-now)))
    (expect-eq !>(1) !>((comet-full-mins:ls us (sub (need until) ~s1))))
    %+  expect-eq
      !>('Too many anonymous comments here right now, try again in 50 min')
    !>((comet-full-words:ls 50))
    ::  at the cap's end the window has rolled: no minutes, and the next is taken
    (expect-eq !>(0) !>((comet-full-mins:ls us (need until))))
    (expect-eq !>([%ok ~]) !>((comet-gate:ls [%open cg-ten] cg-comet (need until))))
    (expect-eq !>(~) !>((comet-full-until:ls cg-ten (need until))))
  ==
::
::  ==  folder sharing  ==
::
++  dirs-ab
  ^-  (map path dir-mode:ls)
  %-  ~(gas by *(map path dir-mode:ls))
  :~  [/a %shared]
      [/a/b %clearweb]
      [/a/c %private]
  ==
::  a page takes the nearest folder above it, at any depth
++  test-dir-nearest
  ;:  weld
    (expect-eq !>(`[/a %shared]) !>((dir-nearest:ls dirs-ab /a/x)))
    (expect-eq !>(`[/a %shared]) !>((dir-nearest:ls dirs-ab /a/x/y/z)))
    ::  a nested folder with its own setting wins over the outer one
    (expect-eq !>(`[/a/b %clearweb]) !>((dir-nearest:ls dirs-ab /a/b/p)))
    (expect-eq !>(`[/a/b %clearweb]) !>((dir-nearest:ls dirs-ab /a/b/q/p)))
    ::  a folder set private sets nothing: the outer folder shows through
    (expect-eq !>(`[/a %shared]) !>((dir-nearest:ls dirs-ab /a/c/p)))
    ::  a folder's own setting is for the pages under it, not the folder
    (expect-eq !>(`[/a %shared]) !>((dir-nearest:ls dirs-ab /a/b)))
    (expect-eq !>(~) !>((dir-nearest:ls dirs-ab /a)))
    ::  moved out: nothing above it, so nothing taken
    (expect-eq !>(~) !>((dir-nearest:ls dirs-ab /z/p)))
    (expect-eq !>(~) !>((dir-nearest:ls dirs-ab /p)))
    (expect-eq !>(~) !>((dir-nearest:ls dirs-ab /)))
  ==
::  a sensitive page is never shared by a folder rule
++  test-dir-target-sensitive
  ;:  weld
    (expect-eq !>(~) !>((dir-target:ls dirs-ab /a/x &)))
    (expect-eq !>(`[/a %shared]) !>((dir-target:ls dirs-ab /a/x |)))
    ::  but its own explicit setting still stands
    (expect-eq !>(%shared) !>((dir-effective:ls `%shared dirs-ab /a/x &)))
    (expect-eq !>(%private) !>((dir-effective:ls ~ dirs-ab /a/x &)))
  ==
::  a page's own setting wins, explicit private included
++  test-dir-effective-override
  ;:  weld
    (expect-eq !>(%private) !>((dir-effective:ls `%private dirs-ab /a/x |)))
    (expect-eq !>(%clearweb) !>((dir-effective:ls `%clearweb dirs-ab /a/x |)))
    (expect-eq !>(%shared) !>((dir-effective:ls ~ dirs-ab /a/x |)))
    (expect-eq !>(%clearweb) !>((dir-effective:ls ~ dirs-ab /a/b/x |)))
    (expect-eq !>(%private) !>((dir-effective:ls ~ dirs-ab /q/x |)))
  ==
::  +dir-plan: what the writer does to one page
++  test-dir-plan
  ;:  weld
    ::  own setting: kept whatever the folder says
    (expect-eq !>([%keep ~]) !>((dir-plan:ls & ~ %private `[/a %shared])))
    ::  no setting: takes the folder's
    (expect-eq !>([%set /a %shared]) !>((dir-plan:ls | ~ %private `[/a %shared])))
    ::  already holds it from that folder: nothing to do
    (expect-eq !>([%keep ~]) !>((dir-plan:ls | `/a %shared `[/a %shared])))
    ::  the folder changed mode: follow it
    (expect-eq !>([%set /a %clearweb]) !>((dir-plan:ls | `/a %shared `[/a %clearweb])))
    ::  same mode from another folder (moved): restamp the via
    (expect-eq !>([%set /b %shared]) !>((dir-plan:ls | `/a %shared `[/b %shared])))
    ::  unshared, or moved out: the inherited setting goes
    (expect-eq !>([%drop ~]) !>((dir-plan:ls | `/a %shared ~)))
    ::  nothing inherited and nothing to take: nothing to do
    (expect-eq !>([%keep ~]) !>((dir-plan:ls | ~ %private ~)))
  ==
::  unshare end to end: the folder's setting goes, its pages drop, a page
::  with its own setting stays, and a nested folder's pages fall back
++  test-dir-unshare
  =/  after=(map path dir-mode:ls)  (~(del by dirs-ab) /a)
  ;:  weld
    (expect-eq !>([%drop ~]) !>((dir-plan:ls | `/a %shared (dir-target:ls after /a/x |))))
    (expect-eq !>([%keep ~]) !>((dir-plan:ls & ~ %shared (dir-target:ls after /a/x |))))
    (expect-eq !>([%keep ~]) !>((dir-plan:ls | `/a/b %clearweb (dir-target:ls after /a/b/x |))))
    ::  a page under a folder set private took the outer one, and drops now
    (expect-eq !>([%drop ~]) !>((dir-plan:ls | `/a %shared (dir-target:ls after /a/c/x |))))
  ==
++  test-pub-key-rel
  ;:  weld
    (expect-eq !>(`/a/b) !>((pub-key-rel:ls /pub/a/b/gmi)))
    (expect-eq !>(~) !>((pub-key-rel:ls /pub/gmi)))
    (expect-eq !>(~) !>((pub-key-rel:ls /a/b/gmi)))
    (expect-eq !>(~) !>((pub-key-rel:ls /pub/a/b)))
  ==
::  a folder's index: its pages and subfolders, by name or by date
++  test-dir-rows
  =/  keys=(list [rel=path when=@da])
    :~  [/site/zeta ~2026.1.3]
        [/site/alpha ~2026.1.5]
        [/site/docs/one ~2026.1.1]
        [/site/docs/deep/two ~2026.1.4]
        [/other/x ~2026.1.2]
        [/site ~2026.1.9]
    ==
  ;:  weld
    %+  expect-eq
      !>  ^-  (list dir-row:ls)
      ~[[%docs | ~2026.1.4] [%alpha & ~2026.1.5] [%zeta & ~2026.1.3]]
    !>((dir-rows:ls keys /site |))
    %+  expect-eq
      !>  ^-  (list dir-row:ls)
      ~[[%zeta & ~2026.1.3] [%docs | ~2026.1.4] [%alpha & ~2026.1.5]]
    !>((dir-rows:ls keys /site &))
    %+  expect-eq
      !>  ^-  (list dir-row:ls)
      ~[[%deep | ~2026.1.4] [%one & ~2026.1.1]]
    !>((dir-rows:ls keys /site/docs |))
    (expect-eq !>(*(list dir-row:ls)) !>((dir-rows:ls keys /nowhere |)))
  ==
::
::  ==  page titles  ==
::
++  test-titles-round-trip
  =/  rows=(map @t title-row:ls)
    %-  ~(gas by *(map @t title-row:ls))
    :~  ['/site/a' 1.700.000.000 'Alpha page']
        ['/site/docs/one' 1.700.000.500 '']
    ==
  ;:  weld
    (expect-eq !>(rows) !>((titles-rows:ls (titles-cord:ls rows))))
    ::  the lines are sorted by key, tab separated
    %+  expect-eq  !>('/site/a\091700000000\09Alpha page\0a/site/docs/one\091700000500\09')
    !>((titles-cord:ls rows))
  ==
::  a title cannot break its line or its fields
++  test-titles-clean
  =/  rows=(map @t title-row:ls)
    (~(gas by *(map @t title-row:ls)) ~[['/a' 5 'one\09two\0athree']])
  %+  expect-eq  !>(`title-row:ls`[5 'one two three'])
  !>((~(got by (titles-rows:ls (titles-cord:ls rows))) '/a'))
::  a line that will not read is dropped, the rest kept
++  test-titles-bad-lines
  =/  got=(map @t title-row:ls)
    (titles-rows:ls 'junk\0a/a\09x\09T\0a\0912\09no key\0a/b\0912\09Bee')
  ;:  weld
    (expect-eq !>(1) !>(~(wyt by got)))
    (expect-eq !>(`title-row:ls`[12 'Bee']) !>((~(got by got) '/b')))
  ==
::  a peer's titles: each title cleaned and capped, and a cord past the
::  1 MB guard is not parsed at all
++  test-peer-titles
  =/  long=@t  (crip (reap 400 'x'))
  =/  c=@t  (crip :(weld "/a\0912\09one\09two\0a/b\0913\09" (trip long)))
  =/  got=(map @t title-row:ls)  (peer-titles:ls c)
  =/  big=@t  (crip (reap +(peer-titles-max:ls) 'y'))
  ;:  weld
    (expect-eq !>(`title-row:ls`[12 'one two']) !>((~(got by got) '/a')))
    (expect-eq !>(title-cap:ls) !>((met 3 title:(~(got by got) '/b'))))
    (expect-eq !>(~) !>((peer-titles:ls (cat 3 '/c\0914\09T\0a' big))))
  ==
::  the reader's policy for a peer's page loads nothing from another
::  host, and the outside toggle opens https images alone
++  test-peer-csp
  =/  shut=tape  (trip (peer-csp:ls |))
  =/  open=tape  (trip (peer-csp:ls &))
  =/  has  |=([n=tape h=tape] ?=(^ (find n h)))
  ;:  weld
    (expect-eq !>(&) !>((has "img-src 'self' data:;" shut)))
    (expect-eq !>(|) !>((has "https:" shut)))
    (expect-eq !>(|) !>((has "*" shut)))
    (expect-eq !>(&) !>((has "connect-src 'self';" shut)))
    (expect-eq !>(&) !>((has "img-src 'self' data: https:;" open)))
    (expect-eq !>(&) !>((has "font-src 'self' data:;" open)))
  ==
::  the policy goes first in the head and the foot before </body>; a
::  document of another shape is left alone
++  test-peer-doc
  =/  d=@t  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title></head><body>B</body></html>'
  =/  got=@t  (peer-doc:ls 'img-src x' '<p>F</p>' d)
  ;:  weld
    %+  expect-eq
      !>('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="img-src x"><title>t</title></head><body>B<p>F</p></body></html>')
      !>(got)
    (expect-eq !>('<p>x</p>') !>((peer-doc:ls 'c' 'f' '<p>x</p>')))
  ==
::  the outside toggle is per page: the cookie names the page by hash
++  test-outside-on
  =/  a=@t  'urb://~zod/pub/a'
  =/  k=tape  (outside-key:ls a)
  =/  ck=@t  (crip :(weld "x=1; latout=" (outside-key:ls 'urb://~zod/pub/b') "." k "; y=2"))
  ;:  weld
    (expect-eq !>(&) !>((outside-on:ls ck a)))
    (expect-eq !>(|) !>((outside-on:ls ck 'urb://~zod/pub/c')))
    (expect-eq !>(|) !>((outside-on:ls '' a)))
    (expect-eq !>(|) !>((outside-on:ls (crip (weld "xlatout=" k)) a)))
    (expect-eq !>(16) !>((lent k)))
  ==
::  the label falls back to the name, and a folder is its name
++  test-row-label
  =/  rows=(map @t title-row:ls)
    (~(gas by *(map @t title-row:ls)) ~[['/site/a' 1 'Alpha'] ['/site/b' 1 '']])
  ;:  weld
    (expect-eq !>("Alpha") !>((row-label:ls rows /site %a &)))
    (expect-eq !>("b") !>((row-label:ls rows /site %b &)))
    (expect-eq !>("c") !>((row-label:ls rows /site %c &)))
    (expect-eq !>("docs/") !>((row-label:ls rows /site %docs |)))
  ==
::  titles feed +dir-rows: rels and dates
++  test-titles-keys
  =/  rows=(map @t title-row:ls)
    (~(gas by *(map @t title-row:ls)) ~[['/site/a' 60 'A'] ['bad' 1 'X']])
  %+  expect-eq  !>(`(list [rel=path when=@da])`~[[/site/a (add ~1970.1.1 ~m1)]])
  !>((titles-keys:ls rows))
::
::  ==  folder grants to ships  ==
::
++  grants-fg
  ^-  (map path (map @t @t))
  %-  ~(gas by *(map path (map @t @t)))
  :~  [/f (~(gas by *(map @t @t)) ~[['nec' 'read']])]
      [/f/sub (~(gas by *(map @t @t)) ~[['nec' 'edit'] ['bus' 'read']])]
  ==
::  a page added to a folder shared with a ship is granted to it, at any
::  depth, and a page elsewhere is not
++  test-grants-above-added
  ;:  weld
    (expect-eq !>((~(gas by *(map @t @t)) ~[['nec' 'read']])) !>((grants-above:ls grants-fg /f/a)))
    %+  expect-eq  !>((~(gas by *(map @t @t)) ~[['nec' 'edit'] ['bus' 'read']]))
    !>((grants-above:ls grants-fg /f/sub/deep/b))
    (expect-eq !>(*(map @t @t)) !>((grants-above:ls grants-fg /g/a)))
    ::  a folder's grant is for the pages under it, not the folder
    (expect-eq !>(*(map @t @t)) !>((grants-above:ls grants-fg /f)))
  ==
::  moved in: the grants of where it lands; moved out: nothing from where
::  it was
++  test-grants-above-moved
  ;:  weld
    (expect-eq !>((~(gas by *(map @t @t)) ~[['nec' 'read']])) !>((grants-above:ls grants-fg /f/moved-in)))
    (expect-eq !>(*(map @t @t)) !>((grants-above:ls grants-fg /out/moved)))
  ==
::  moving out takes back what the folders gave, and nothing given by hand
++  test-revoke-groups
  ;:  weld
    (expect-eq !>((silt ~['nec'])) !>((revoke-groups:ls grants-fg ~[/f])))
    (expect-eq !>((silt ~['nec' 'bus'])) !>((revoke-groups:ls grants-fg ~[/f/sub /f])))
    (expect-eq !>(*(set @t)) !>((revoke-groups:ls grants-fg ~)))
    (expect-eq !>(*(set @t)) !>((revoke-groups:ls grants-fg ~[/gone])))
  ==
::  unsharing a folder takes back what its rule granted: the pages whose
::  grant-via names it, and its folders' indexes
++  test-ungrant
  =/  g=(map path (map @t @t))
    (~(put by grants-fg) /f/sub (~(gas by *(map @t @t)) ~[['bus' 'read']]))
  =/  pages=(list [rel=path vias=(list path) own=(map @t @t)])
    :~  [/f/a ~[/f] ~]
        [/f/own ~ ~]
        [/f/sub/b ~[/f/sub /f] ~]
    ==
  %+  expect-eq  !>([~[[/f/a ''] [/f/sub/b '']] ~[/f /f/sub]])
  !>((ungrant:ls g 'nec' /f pages ~[/f /f/sub]))
::  what another folder still sharing with the group gives stays, at
::  that folder's mode
++  test-ungrant-covered
  =/  pages=(list [rel=path vias=(list path) own=(map @t @t)])
    :~  [/f/a ~[/f] ~]
        [/f/sub/b ~[/f/sub /f] ~]
    ==
  ;:  weld
    ::  /f/sub shares with nec too: its page and index stay
    %+  expect-eq  !>([~[[/f/a '']] ~[/f]])
    !>((ungrant:ls grants-fg 'nec' /f pages ~[/f /f/sub]))
    ::  a folder above sharing with nec for read leaves /f/a read
    =/  up  (~(put by grants-fg) / (~(gas by *(map @t @t)) ~[['nec' 'read']]))
    %+  expect-eq  !>([~[[/f/a 'read']] `(list path)`~])
    !>((ungrant:ls up 'nec' /f pages ~[/f /f/sub]))
    ::  a group the folder never shared with takes nothing
    %+  expect-eq  !>([~[[/f/a ''] [/f/sub/b '']] ~[/f /f/sub]])
    !>((ungrant:ls grants-fg 'zod' /f pages ~[/f /f/sub]))
  ==
::  a page's own grant stays at its own mode: read under an edit folder
::  share is left read, edit under a read share is left alone, and
::  another group's own grant does not count
++  test-ungrant-own
  =/  ed=(map path (map @t @t))
    (~(gas by *(map path (map @t @t))) ~[[/f (~(gas by *(map @t @t)) ~[['nec' 'edit']])]])
  =/  rd  (~(gas by *(map @t @t)) ~[['nec' 'read']])
  =/  pages=(list [rel=path vias=(list path) own=(map @t @t)])
    :~  [/f/a ~[/f] rd]
        [/f/b ~[/f] (~(gas by *(map @t @t)) ~[['nec' 'edit']])]
        [/f/c ~[/f] (~(gas by *(map @t @t)) ~[['bus' 'edit']])]
    ==
  ;:  weld
    %+  expect-eq  !>([~[[/f/a 'read'] [/f/c '']] ~[/f]])
    !>((ungrant:ls ed 'nec' /f pages ~[/f]))
    %+  expect-eq  !>([~[[/f/a 'read'] [/f/c '']] ~[/f]])
    !>((ungrant:ls grants-fg 'nec' /f pages ~[/f]))
  ==
::  a page's own grant as a folder starts to share it
++  test-own-infer
  ;:  weld
    ::  held by hand, no folder: its own, at its mode
    (expect-eq !>('read') !>((own-infer:ls '' 'read' '')))
    (expect-eq !>('edit') !>((own-infer:ls '' 'edit' '')))
    ::  held at what a folder gives: not known to be its own
    (expect-eq !>('') !>((own-infer:ls '' 'read' 'read')))
    ::  held wider than the folders give: the rest was by hand
    (expect-eq !>('edit') !>((own-infer:ls '' 'edit' 'read')))
    ::  noted own stays, never wider than now held
    (expect-eq !>('read') !>((own-infer:ls 'read' 'edit' 'edit')))
    (expect-eq !>('read') !>((own-infer:ls 'edit' 'read' 'read')))
    ::  a stale note on a group no longer granting it goes
    (expect-eq !>('') !>((own-infer:ls 'edit' '' '')))
  ==
++  test-mode-max
  ;:  weld
    (expect-eq !>('edit') !>((mode-max:ls 'read' 'edit')))
    (expect-eq !>('read') !>((mode-max:ls '' 'read')))
    (expect-eq !>('') !>((mode-max:ls '' '')))
    (expect-eq !>('read') !>((mode-min:ls 'read' 'edit')))
  ==
::
::  ==  followed folders  ==
::
++  fold-rows
  ^-  (map @t title-row:ls)
  (~(gas by *(map @t title-row:ls)) ~[['/f/a' 10 'A'] ['/f/sub/b' 20 'B']])
::  following marks nothing new; a page added, or changed, since is new
++  test-fold-new
  =/  fs=(list fold:ls)  (fold-add:ls ~ nec /f `fold-rows ~2026.1.1)
  =/  f0=fold:ls  (need (fold-get:ls fs nec /f))
  =/  more  (~(put by (~(put by fold-rows) '/f/c' [30 'C'])) '/f/a' [11 'A2'])
  =/  fs1=(list fold:ls)  (fold-read:ls fs nec /f `more ~2026.1.2)
  =/  f1=fold:ls  (need (fold-get:ls fs1 nec /f))
  ;:  weld
    (expect-eq !>(0) !>((fold-new:ls f0)))
    (expect-eq !>(%.y) !>(ok.f0))
    (expect-eq !>(2) !>((fold-new:ls f1)))
    ::  opening a page clears its new, and only its
    (expect-eq !>(1) !>((fold-new:ls (need (fold-get:ls (fold-seen:ls fs1 nec /f '/f/c') nec /f)))))
    ::  a key it does not list is nothing to see
    (expect-eq !>(fs1) !>((fold-seen:ls fs1 nec /f '/f/zz')))
  ==
::  a folder that will not read turns unavailable and keeps its pages;
::  reading again brings it back
++  test-fold-unavailable
  =/  fs=(list fold:ls)  (fold-add:ls ~ nec /f `fold-rows ~2026.1.1)
  =/  gone=(list fold:ls)  (fold-read:ls fs nec /f ~ ~2026.1.2)
  =/  g=fold:ls  (need (fold-get:ls gone nec /f))
  =/  back=fold:ls  (need (fold-get:ls (fold-read:ls gone nec /f `fold-rows ~2026.1.3) nec /f))
  ;:  weld
    (expect-eq !>(%.n) !>(ok.g))
    (expect-eq !>(fold-rows) !>(late.g))
    (expect-eq !>(%.y) !>(ok.back))
    ::  a folder unreadable when followed is followed, unavailable
    (expect-eq !>(%.n) !>(ok:(need (fold-get:ls (fold-add:ls ~ bus /g ~ ~2026.1.1) bus /g))))
    ::  a read of a folder nobody follows changes nothing
    (expect-eq !>(fs) !>((fold-read:ls fs bus /f `fold-rows ~2026.1.2)))
  ==
::  following again keeps what was seen; unfollowing is one follow gone
++  test-fold-add-del
  =/  fs=(list fold:ls)  (fold-add:ls ~ nec /f `fold-rows ~2026.1.1)
  =/  more  (~(put by fold-rows) '/f/c' [30 'C'])
  =/  fs2=(list fold:ls)  (fold-add:ls fs nec /f `more ~2026.1.2)
  =/  fs3=(list fold:ls)  (fold-add:ls fs2 bus /f `more ~2026.1.2)
  ;:  weld
    (expect-eq !>(1) !>((lent fs2)))
    (expect-eq !>(1) !>((fold-new:ls (need (fold-get:ls fs2 nec /f)))))
    (expect-eq !>(2) !>((lent fs3)))
    (expect-eq !>(~[bus]) !>((turn (fold-del:ls fs3 nec /f) |=(f=fold:ls host.f))))
  ==
::  a ship's titles under a folder, at any depth, and nothing beside it
++  test-fold-under
  =/  all  (~(gas by *(map @t title-row:ls)) ~[['/f/a' 1 'A'] ['/f/s/b' 2 'B'] ['/fx/c' 3 'C'] ['/g' 4 'G']])
  %+  expect-eq  !>((~(gas by *(map @t title-row:ls)) ~[['/f/a' 1 'A'] ['/f/s/b' 2 'B']]))
  !>((fold-under:ls all /f))
::  a share notice's page names the follow it falls under on that host
++  test-fold-hit
  =/  fs=(list fold:ls)  (fold-add:ls (fold-add:ls ~ nec /f `fold-rows ~2026.1.1) bus /f ~ ~2026.1.1)
  ;:  weld
    (expect-eq !>(~[/f]) !>((turn (fold-hit:ls fs nec /apps/lattice/page/f/a/code) |=(f=fold:ls rel.f))))
    (expect-eq !>(~) !>((fold-hit:ls fs nec /apps/lattice/page/fx/a/code)))
    (expect-eq !>(~) !>((fold-hit:ls fs zod /apps/lattice/page/f/a/code)))
    ::  a page named b/page/f/a is not under /f
    (expect-eq !>(~) !>((fold-hit:ls fs nec /apps/lattice/page/b/page/f/a/code)))
  ==
::  a folder's notice reaches the follows at, above and below it, and no
::  folder beside it
++  test-fold-hit-dir
  =/  fs=(list fold:ls)
    (fold-add:ls (fold-add:ls (fold-add:ls ~ nec /f `fold-rows ~2026.1.1) nec /f/s ~ ~2026.1.1) nec /fx ~ ~2026.1.1)
  =/  hit  |=(p=path (sort (turn (fold-hit:ls fs nec p) |=(f=fold:ls rel.f)) aor))
  ;:  weld
    (expect-eq !>((sort `(list path)`~[/f /f/s] aor)) !>((hit /apps/lattice/page/f/dir-index)))
    (expect-eq !>(`(list path)`~[/f /f/s]) !>((hit /apps/lattice/page/f/s/dir-index)))
    (expect-eq !>(`(list path)`~[/f]) !>((hit /apps/lattice/page/f/t/dir-index)))
    (expect-eq !>(`(list path)`~) !>((hit /apps/lattice/page/g/dir-index)))
  ==
::  +holds-trim: a folder held whole is one hold. The pages and folders
::  under it go, unless the page's mode is wider than the folder's. A page
::  shared on its own and in the folder shows once, as the folder.
++  test-holds-folder
  =/  gs=(list [who=(set @p) peek=(set path) make=(set path) dirs=(map path @t)])
    :~  :^  (silt ~[zod bus])  (silt `(list path)`~[/f/a/code /f/b/code /f/s/c/code /g/code])
          (silt ~[/f/b/code])
        (malt `(list [path @t])`~[[/f/dir-index 'read'] [/f/s/dir-index 'read']])
        [(silt ~[bus]) (silt ~[/f/a/code]) ~ (malt ~[[/f/dir-index 'edit']])]
    ==
  =/  h=holds:ls  (holds-of:ls gs)
  ;:  weld
    ::  the folder, the page it may edit in it, and the page outside it
    %+  expect-eq
      !>((malt `(list [path @t])`~[[/f/dir-index 'read'] [/f/b/code 'edit'] [/g/code 'read']]))
      !>((~(got by h) zod))
    ::  edit on the folder covers the edit page too
    %+  expect-eq
      !>((malt `(list [path @t])`~[[/f/dir-index 'edit'] [/g/code 'read']]))
      !>((~(got by h) bus))
    ::  shared whole after page by page: one add for the folder, a del
    ::  for each page it now covers
    %+  expect-eq
      !>([`(list [@p path @t])`~[[zod /f/dir-index 'read']] (sort `(list [@p path])`~[[zod /f/a/code] [zod /f/s/c/code]] aor)])
      !>  %+  holds-diff:ls
            (holds-of:ls ~[[(silt ~[zod]) (silt `(list path)`~[/f/a/code /f/s/c/code]) ~ ~]])
          (holds-of:ls ~[[(silt ~[zod]) (silt `(list path)`~[/f/a/code /f/s/c/code]) ~ (malt ~[[/f/dir-index 'read']])]])
  ==
::  +dir-cover: a folder notice falls in its own entry or one above it,
::  from that host only, and never in a page's entry
++  test-dir-cover
  =/  cur=shared:ls
    :~  [zod /apps/l/page/f/dir-index 'read' ~2026.1.1]
        [bus /apps/l/page/g/dir-index 'read' ~2026.1.1]
        [zod /apps/l/page/h/code 'read' ~2026.1.1]
    ==
  ;:  weld
    (expect-eq !>(`(snag 0 cur)) !>((dir-cover:ls cur zod /apps/l/page/f/dir-index)))
    (expect-eq !>(`(snag 0 cur)) !>((dir-cover:ls cur zod /apps/l/page/f/s/dir-index)))
    (expect-eq !>(~) !>((dir-cover:ls cur zod /apps/l/page/fx/dir-index)))
    (expect-eq !>(~) !>((dir-cover:ls cur zod /apps/l/page/g/dir-index)))
    (expect-eq !>(~) !>((dir-cover:ls cur zod /apps/l/page/h/s/dir-index)))
    (expect-eq !>(&) !>((dir-key:ls /apps/l/page/f/dir-index)))
    (expect-eq !>(|) !>((dir-key:ls /apps/l/page/dir-index/code)))
  ==
::  +move-resumes: a fresh note for the same move resumes it. A stale one,
::  or one for another move, does not, so the move gets the clobber checks.
++  test-move-resumes
  =/  t0  ~2026.11.6..12.00.00
  =/  job  `[/a /b t0]
  ;:  weld
    (expect-eq !>(&) !>((move-resumes:ls job /a /b (add t0 ~m3) ~m10)))
    (expect-eq !>(|) !>((move-resumes:ls job /a /b (add t0 ~h1) ~m10)))
    (expect-eq !>(|) !>((move-resumes:ls job /a /c (add t0 ~m1) ~m10)))
    (expect-eq !>(|) !>((move-resumes:ls ~ /a /b t0 ~m10)))
    ::  a clock that stepped back reads as fresh rather than crashing
    (expect-eq !>(&) !>((move-resumes:ls job /a /b (sub t0 ~m1) ~m10)))
  ==
::  a new page rewrites the indexes on its own path only: from the highest
::  folder that keeps one down to its own, never a folder beside it
++  test-index-ups
  ;:  weld
    (expect-eq !>(`(list path)`~[/f /f/s]) !>((index-ups:ls /f/s (silt `(list path)`~[/f /f/s /f/t]))))
    ::  a new subfolder under an indexed one gets an index
    (expect-eq !>(`(list path)`~[/f /f/s /f/s/n]) !>((index-ups:ls /f/s/n (silt `(list path)`~[/f /f/t]))))
    ::  only the nearer index: the higher folder is not shared
    (expect-eq !>(`(list path)`~[/f/s]) !>((index-ups:ls /f/s (silt `(list path)`~[/f/s /g]))))
    (expect-eq !>(`(list path)`~) !>((index-ups:ls /f/s (silt `(list path)`~[/g]))))
    (expect-eq !>(`(list path)`~[/]) !>((index-ups:ls / (silt ~[`path`/]))))
  ==
::  +holds-of: who reads which page, across every group. A ship in two
::  groups reads the union, and edit wins over read.
::
++  test-holds-of
  =/  gs=(list [who=(set @p) peek=(set path) make=(set path) dirs=(map path @t)])
    :~  [(silt ~[zod bus]) (silt ~[/a/code /b/code]) (silt ~[/b/code]) ~]
        [(silt ~[zod]) (silt ~[/b/code /c/code]) ~ ~]
        [(silt ~[nec]) ~ ~ ~]
    ==
  =/  h=holds:ls  (holds-of:ls gs)
  ;:  weld
    %+  expect-eq
      !>((malt ~[[/a/code 'read'] [/b/code 'edit'] [/c/code 'read']]))
      !>((~(got by h) zod))
    %+  expect-eq
      !>((malt ~[[/a/code 'read'] [/b/code 'edit']]))
      !>((~(got by h) bus))
    ::  a ship in a group with no pages holds nothing
    (expect-eq !>(|) !>((~(has by h) nec)))
  ==
::  +holds-diff: only the change is told. A page a ship held already is no
::  add (the duplicate notice this exists to avoid), a new mode is one, a
::  page held through another group after a revoke is no del.
::
++  test-holds-diff
  =/  old=holds:ls
    (malt ~[[zod (malt ~[[/a/code 'read'] [/b/code 'read']])] [bus (malt ~[[/a/code 'read']])]])
  =/  new=holds:ls
    (malt ~[[zod (malt ~[[/a/code 'read'] [/b/code 'edit'] [/c/code 'read']])] [nec (malt ~[[/a/code 'read']])]])
  =/  d  (holds-diff:ls old new)
  ;:  weld
    %+  expect-eq
      !>  %+  sort  ~[[zod /b/code 'edit'] [zod /c/code 'read'] [nec /a/code 'read']]
          |=([a=[@p path @t] b=[@p path @t]] (aor a b))
      !>(add.d)
    (expect-eq !>(~[[bus /a/code]]) !>(del.d))
    ::  no change, nothing told
    (expect-eq !>([~ ~]) !>((holds-diff:ls new new)))
  ==
::
::  ==  invariants pass, 2026-11-07  ==
::
::  item 1: a page is sensitive by the nearest flag at or above it in the
::  folder, else by what the folder takes from above
++  test-sens-at
  =/  fl=(map path ?)  (~(gas by *(map path ?)) ~[[/a &] [/a/b/c |]])
  ;:  weld
    (expect-eq !>(&) !>((sens-at:ls fl | /a/x)))
    (expect-eq !>(&) !>((sens-at:ls fl | /a/b/d)))
    (expect-eq !>(|) !>((sens-at:ls fl | /a/b/c)))
    (expect-eq !>(|) !>((sens-at:ls fl | /z)))
    (expect-eq !>(&) !>((sens-at:ls fl & /z)))
    (expect-eq !>(&) !>((sens-at:ls ~ & ~)))
  ==
::  item 2: a tainted key writes only a sensitive page that is not
::  published and granted to no ship
++  test-taint-dest
  ;:  weld
    (expect-eq !>(&) !>((taint-dest:ls & | |)))
    (expect-eq !>(|) !>((taint-dest:ls & & |)))
    (expect-eq !>(|) !>((taint-dest:ls & | &)))
    (expect-eq !>(|) !>((taint-dest:ls | | |)))
  ==
::  item 3: a ban strips the ship's whole family from a group: moons of a
::  banned planet, every comet when the comets are banned
++  test-ban-drop-family
  =/  pl=@p  ~sampel-palnet
  =/  moon=@p  (cat 5 pl 7)
  =/  other=@p  (cat 5 ~nec 7)
  =/  comet=@p  (cat 7 (bex 64) 1)
  =/  ships=(set @p)  (~(gas in *(set @p)) ~[pl moon other comet ~bus])
  ;:  weld
    %+  expect-eq  !>((~(gas in *(set @p)) ~[other comet ~bus]))
    !>((ban-drop:ls (~(gas in *(set @p)) ~[pl]) ships))
    %+  expect-eq  !>((~(gas in *(set @p)) ~[pl moon other ~bus]))
    !>((ban-drop:ls (~(gas in *(set @p)) ~[all-comets:ls]) ships))
    (expect-eq !>(ships) !>((ban-drop:ls ~ ships)))
  ==
::  item 4: a group write drops whoever is banned at write time, so a
::  share that read the old members cannot write a stripped ship back
++  test-ban-drop-race
  =/  old=(set @p)  (~(gas in *(set @p)) ~[~nec ~bus])
  =/  bans=banned:ls  (~(gas in *(set @p)) ~[~nec])
  (expect-eq !>((~(gas in *(set @p)) ~[~bus ~wes])) !>((ban-drop:ls bans (~(put in old) ~wes))))
::  item 5: a folder grant in a weir with no note is found, at its mode,
::  and a subfolder's index under a noted folder is no orphan
++  test-grant-orphans
  =/  recs=(map path (map @t @t))
    (~(gas by *(map path (map @t @t))) ~[[/f (~(gas by *(map @t @t)) ~[['nec' 'read']])]])
  ;:  weld
    %+  expect-eq
      !>(`(list [g=@t f=path md=@t])`~[['bus' /f 'edit'] ['nec' /g 'read']])
    !>((grant-orphans:ls ~[['nec' /f |] ['bus' /f &] ['nec' /g |] ['nec' /f/s |]] recs))
    ::  the orphan's own subfolders are covered once it is noted
    %+  expect-eq
      !>(`(list [g=@t f=path md=@t])`~[['nec' /g 'read']])
    !>((grant-orphans:ls ~[['nec' /g/s |] ['nec' /g |]] ~))
  ==
::  item 6: one host holds at most +host-cap entries, and a re-share of
::  one it holds still lands; paths are bounded
++  test-host-full
  =/  many=shared:ls
    %+  turn  (gulf 1 host-cap:ls)
    |=(i=@ud `entry:ls`[~nec /apps/(scot %ud i) 'read' ~2024.1.1])
  ;:  weld
    (expect-eq !>(&) !>((host-full:ls many ~nec /apps/new)))
    (expect-eq !>(|) !>((host-full:ls many ~nec /apps/'1')))
    (expect-eq !>(|) !>((host-full:ls many ~bus /apps/new)))
    (expect-eq !>(|) !>((host-full:ls (slag 1 many) ~nec /apps/new)))
  ==
++  test-pax-ok
  ;:  weld
    (expect-eq !>(&) !>((pax-ok:ls /apps/lattice/page/a/code)))
    (expect-eq !>(|) !>((pax-ok:ls (reap 65 %a))))
    (expect-eq !>(|) !>((pax-ok:ls ~[%apps (crip (reap 3.000 'a'))])))
    (expect-eq !>(|) !>((pax-ok:ls ~[%apps %$])))
    (expect-eq !>(|) !>((pax-ok:ls ~[%apps 'A B'])))
  ==
::  item 7: an unacked revoke is sent again a bounded number of times
++  test-del-waits
  ;:  weld
    (expect-eq !>(`~s30) !>((del-waits:ls 0)))
    (expect-eq !>(`~h6) !>((del-waits:ls 4)))
    (expect-eq !>(~) !>((del-waits:ls 5)))
  ==
::  item 8: a stored mode other than read or edit is no grant
++  test-clean-modes
  =/  gs=(map @t @t)
    (~(gas by *(map @t @t)) ~[['a' 'read'] ['b' 'edit'] ['c' 'admin'] ['d' '']])
  ;:  weld
    %+  expect-eq  !>((~(gas by *(map @t @t)) ~[['a' 'read'] ['b' 'edit']]))
    !>((clean-modes:ls gs))
    %+  expect-eq  !>(`shared:ls`~[[~nec /apps/a 'read' ~2024.1.1]])
    !>((clean-shared:ls ~[[~nec /apps/a 'read' ~2024.1.1] [~nec /apps/b 'own' ~2024.1.1]]))
    (expect-eq !>(|) !>((mode-ok:ls 'Edit')))
  ==
::  item 9: a sub-folder notice wider than the folder that covers it is
::  new; one no wider is a touch
++  test-dir-touch
  =/  top=entry:ls  [~nec /apps/x/page/f/'dir-index' 'read' ~2024.1.1]
  ;:  weld
    (expect-eq !>(|) !>((dir-touch:ls `top /apps/x/page/f/g/'dir-index' 'edit')))
    (expect-eq !>(&) !>((dir-touch:ls `top /apps/x/page/f/g/'dir-index' 'read')))
    (expect-eq !>(&) !>((dir-touch:ls `top pax.top 'read')))
    (expect-eq !>(|) !>((dir-touch:ls `top pax.top 'edit')))
    (expect-eq !>(|) !>((dir-touch:ls ~ pax.top 'read')))
  ==
::  item 10: the banlist holds +ban-cap ships, not one more
++  test-ban-full
  =/  full=banned:ls
    (~(gas in *(set @p)) (turn (gulf 1 ban-cap:ls) |=(i=@ud `@p`(add 256 i))))
  ;:  weld
    (expect-eq !>(ban-cap:ls) !>(~(wyt in full)))
    (expect-eq !>(&) !>((ban-full:ls full ~sampel-palnet)))
    (expect-eq !>(|) !>((ban-full:ls full `@p`257)))
    (expect-eq !>(|) !>((ban-full:ls (~(del in full) `@p`257) ~sampel-palnet)))
  ==
--
