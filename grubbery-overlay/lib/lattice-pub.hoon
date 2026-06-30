::  Pure helpers for the grubbery-backed public-page store (phase-2 stage 2a).
::
::  Mirrors /lib/lattice-know but simpler: a page is just a gemtext body keyed by
::  its publication path — the %lattice agent's content-map key, e.g.
::  /pub/notes/intro/gmi. Pages are path->body, so there is no tag / move /
::  restore / trash machinery — only upsert (%save-page) and remove (%del-page).
::
::  Like lattice-know, this depends on base + clay types ONLY (path, @ta, @da,
::  @uvH, maps), no grubbery tarball/nexus types, so the SAME file compiles both
::  in the %lattice desk (where these arms are unit-tested) and synced into
::  grubbery's gub/lib (where the %lattice nexus wraps them).
::
|%
::  a stored page: the gemtext body, byte-identical to what content.st holds.
::
+$  page  @t
::  public-page actions poked at the pub writer. Migration reuses %save-page —
::  pages carry no original timestamp to preserve (unlike know imports).
::
+$  pub-action
  $%  [%save-page key=@t body=@t]
      [%del-page key=@t]
  ==
::  derived per-page index row (no bodies). hash = (sham body), the parity key
::  the agent diffs its content-map against; updated/bytes are informational.
::
+$  pub-row    [updated=@da bytes=@ud hash=@uvH]
+$  pub-index  (map path pub-row)
::  +to-pub-row: project a stored page onto its index row.
::
++  to-pub-row
  |=  [body=@t now=@da]
  ^-  pub-row
  [now (met 3 body) (sham body)]
::  +derive-pub-index: index every page. Pure projection of the vault.
::
++  derive-pub-index
  |=  [pages=(map path page) now=@da]
  ^-  pub-index
  (~(run by pages) |=(b=page (to-pub-row b now)))
::  +vrail: a rail expressed structurally (== rail:tarball [p=path name=@ta]) so
::  this lib stays grubbery-free.
::
+$  vrail  [pax=path nom=@ta]
::  +key-to-rail: a content-map key (path) -> the vault rail holding its page,
::  rooted at [base]. Strips the leading `pub` element (redundant with base) and
::  uses the key's own last element as the grub leaf — so /pub/a/gmi and
::  /pub/a/b/gmi both map cleanly (dir /a holds the file `gmi` AND the child dir
::  `b`). ~ for an empty/degenerate key (no leaf to name).
::
++  key-to-rail
  |=  [base=path key=path]
  ^-  (unit vrail)
  =/  rest=path  (strip-pub key)
  ?~  rest  ~
  ::  dir = all-but-last, leaf = last. scag/snag/lent (not rear/snip) to match
  ::  the portable vocabulary lattice-know uses.
  =/  n=@ud  (dec (lent rest))
  `[(weld base (scag n rest)) (snag n rest)]
::  +strip-pub: drop a leading `pub` element (the content map's keys are rooted
::  there; the vault base already carries it). Left unchanged if absent.
::
++  strip-pub
  |=  key=path
  ^-  path
  ?:(?=([%pub *] key) (slag 1 key) key)
--
