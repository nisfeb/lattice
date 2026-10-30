::  /lib/lattice-link, a page shared with you, moved into your own tree.
::
::  A link is a `link` grub at /links/<path>, shown in the page tree at
::  <path>. It is not under /page, where any folder grant or publish would
::  hand it (and its cached copy of another ship's page) to others. It is
::  not %code, since the evaluator spawns on any code grub under /page, and
::  not grubbery's %symlink, which can only name a local path. The union
::  leaves room for a local symlink later (%local).
::
::  A %ship link names the host's absolute code-grub path, as the
::  shared-with-me entry carries it. `mode` is the last-known grant, a
::  claim and never a capability: the host's weir is the only authority.
::  The rest is a cache of the last read. `kind` is set once at create and
::  frozen, so a mounted file is never renamed under an open editor.
::
=,  format
|%
+$  seen  [ok=? at=@da]                ::  last read: ok, or failed, when
+$  link
  $%  $:  %ship
          host=@p
          pax=path
          mode=@t                      ::  'read' | 'edit'
          kind=@ta
          body=@t
          rev=@ud
          size=@ud
          =seen
      ==
      [%local pax=path]
  ==
::  +en-link: the link for tree, dump and the page tab. Never the body: it
::  can be large, and listings report size, not content.
++  en-link
  |=  =link
  ^-  json
  ?:  ?=(%local -.link)
    (pairs:enjs ~[local+s+(spat pax.link)])
  %-  pairs:enjs
  :~  host+s+(scot %p host.link)
      path+s+(spat pax.link)
      mode+s+mode.link
      kind+s+kind.link
      :-  %seen
      (pairs:enjs ~[ok+b+ok.seen.link at+s+(scot %da at.seen.link)])
  ==
::  +refresh: a successful read. Body, rev and size update, kind does not
::  (it is frozen at create, whatever the host now says).
++  refresh
  |=  [l=link kind=@ta body=@t rev=@ud now=@da]
  ^-  link
  ?:  ?=(%local -.l)  l
  l(body body, rev rev, size (met 3 body), seen [& now])
::  +fail: a failed read (host offline, or the grant revoked). The cache
::  stays, so the page still shows its last-known copy.
++  fail
  |=  [l=link now=@da]
  ^-  link
  ?:  ?=(%local -.l)  l
  l(seen [| now])
::  +link-name: the display name, the page's own name. pax names the
::  code grub, so a trailing /code is dropped first.
++  link-name
  |=  pax=path
  ^-  @t
  =/  p=path  (flop pax)
  =?  p  ?=([%code *] p)  t.p
  ?~(p '' i.p)
--
