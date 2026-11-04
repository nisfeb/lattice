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
--
