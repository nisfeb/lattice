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
--
