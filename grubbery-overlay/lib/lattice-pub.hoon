::  Pure helpers for the lattice nexus's public-page store (pub grubs).
::
::  Mirrors /lib/lattice-know but simpler: a page is just a gemtext body keyed by
::  its publication path, e.g. /pub/notes/intro/gmi. Pages are path->body, so
::  there is no tag / move / restore / trash machinery — only upsert (%save-page)
::  and remove (%del-page).
::
::  Like lattice-know, this depends on base + clay types ONLY (path, @ta, @da,
::  @uvH, maps), no grubbery tarball/nexus types, so the SAME file compiles both
::  in a plain desk /lib (where these arms are unit-tested) and in grubbery's
::  gub/lib (where the lattice nexus wraps them).
::
|%
::  a stored page: the gemtext body, stored as a bare cord.
::
+$  page  @t
::  public-page actions poked at the pub writer. %save-page is an idempotent
::  upsert; pages carry no timestamp or tags, so there's no separate import
::  action (unlike know entries).
::
+$  pub-action
  $%  [%save-page key=@t body=@t]
      [%del-page key=@t]
  ==
::  derived per-page index row (no bodies). hash = (sham body), the parity key
::  the agent diffs its content-map against; updated/bytes are informational.
::
::  Design note: consumers today read only the KEY set, so a namespace ball-walk
::  (like +reindex does for know) could replace this index. We keep it
::  hand-maintained anyway because `hash` is the reserved parity key for
::  federation sync (diffing our page set against a peer's) — deriving
::  a key-list on demand would drop that column. Caveat: apply-pub writes the vault
::  grub then the index row as two darts, so a crash between them can leave the
::  index missing a live page (drops it from /list until a manual re-save); there
::  is no auto-repair yet (derive-pub-index is unused). Add a pub arm to +reindex
::  if that drift is ever observed in practice.
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
::  +follows: the set of ships the crawler sweeps (one peek, always present).
::  Just ships — the crawler re-crawls each fully per tick; per-follow cursors
::  are a later refinement. +sub-action: the follow-writer's poke.
::
+$  follows  (set @p)
+$  sub-action
  $%  [%follow ship=@p]
      [%unfollow ship=@p]
  ==
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
  ::  =(~ rest) not ?~: ?~ would narrow rest to a non-empty lest, and +scag
  ::  casts its result to its input's type (^+ b) — a narrowed input would make
  ::  scag's possibly-empty result nest-fail. dir = all-but-last, leaf = last.
  ?:  =(~ rest)  ~
  =/  n=@ud  (dec (lent rest))
  `[(weld base (scag n rest)) (snag n rest)]
::  +strip-pub: drop a leading `pub` element (the content map's keys are rooted
::  there; the vault base already carries it). Left unchanged if absent.
::
++  strip-pub
  |=  key=path
  ^-  path
  ?.  ?=(^ key)  key
  ?:(=(%pub i.key) t.key key)
--
