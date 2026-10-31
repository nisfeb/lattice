::  Pure helpers for the lattice nexus's public-page store (pub grubs).
::
::  Mirrors /lib/lattice-know but simpler. A page is just a gemtext body keyed by
::  its publication path, e.g. /pub/notes/intro/gmi. Pages are path->body, so
::  there is no tag / move / restore / trash machinery, only upsert (%save-page)
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
::  upsert. Pages carry no timestamp or tags, so there's no separate import
::  action (unlike know entries).
::
+$  pub-action
  $%  [%save-page key=@t body=@t]
      [%del-page key=@t]
  ==
::  derived per-page index row (no bodies). hash = (sham body), the parity key
::  the agent diffs its content-map against. updated/bytes are informational.
::
::  Design note: consumers today read only the KEY set, so a namespace ball-walk
::  (like +reindex does for know) could replace this index. We keep it
::  hand-maintained anyway because `hash` is the reserved parity key for
::  federation sync (diffing our page set against a peer's). Deriving
::  a key-list on demand would drop that column. Caveat: apply-pub writes the vault
::  grub then the index row as two darts, so a crash between them can leave the
::  index missing a live page (drops it from /list until a manual re-save). There
::  is no auto-repair yet. Add a pub arm to +reindex
::  if that drift is ever observed in practice.
::
::  +pub-pending: the shared pages with a publish waiting or just made,
::  by page rel (spat). Only the key is kept, never a body: the publish
::  reads the page as it is then, so it is always the newest text.
::    last:  when the page was last saved
::    tries: publishes of it tried since it last published
::    sent:  when it last published (0: not since it was marked)
::    dirty: a save is not published yet. A clean row only remembers
::           `sent` for the throttle, and goes a `gap` after it.
::
+$  pub-wait     [last=@da tries=@ud sent=@da dirty=?]
+$  pub-pending  (map @t pub-wait)
::  +pub-old: the map release 79 stored, [first last tries] a row, read
::  so the pages a reload left waiting still publish
+$  pub-old      (map @t [first=@da last=@da tries=@ud])
++  pub-from-old
  |=  old=pub-old
  ^-  pub-pending
  (~(run by old) |=([first=@da last=@da tries=@ud] [last tries *@da &]))
::  +pub-due: when a dirty row publishes. A throttle with a leading edge:
::  a save a `gap` or more after the page's last publish goes at once,
::  and saves inside the gap wait for its end, one publish of the newest
::  text, so a page publishes at most once a gap.
::
++  pub-due
  |=  [row=pub-wait gap=@dr]
  ^-  @da
  (add sent.row gap)
::  +pub-note: a save of the page whose row is `old`, at `now`
::
++  pub-note
  |=  [old=(unit pub-wait) now=@da]
  ^-  pub-wait
  ?~  old  [now 0 *@da &]
  u.old(last now, tries 0, dirty &)
::  +pub-prune: the rows that still mean something at `now`: every dirty
::  one, and a clean one until its gap is over
::
++  pub-prune
  |=  [pen=pub-pending now=@da gap=@dr]
  ^-  pub-pending
  %-  malt
  %+  skim  ~(tap by pen)
  |=([k=@t w=pub-wait] |(dirty.w (gth (pub-due w gap) now)))
::  +pub-done: the row after a publish that started at `at` and ended at
::  `now`, `cur` the row as it is now. A save that came in after `at` may
::  have missed the copy, so it stays dirty for the next window.
::
++  pub-done
  |=  [cur=pub-wait at=@da now=@da]
  ^-  pub-wait
  [last.cur 0 now (gth last.cur at)]
::  +pub-failed: the row after a publish that failed at `now`: one more
::  try, and dirty, so it is tried again a gap later. Only this counts a
::  try; a writer restart (a deploy) leaves the row as it was.
::
++  pub-failed
  |=  [row=pub-wait now=@da]
  ^-  pub-wait
  row(tries +(tries.row), sent now, dirty &)
::  +pub-drop: whether a due row is given up on, after `max` failures
::
++  pub-drop
  |=  [row=pub-wait max=@ud]
  ^-  ?
  (gte tries.row max)
::  +pub-arm-at: when the one publish timer goes off, ~ when no row is
::  dirty. A row already due arms the epoch, so its publish goes before
::  every other past timer set after a save (+defer-at in the nexus),
::  the page evaluator's run among them.
::
++  pub-arm-at
  |=  [pen=pub-pending now=@da gap=@dr]
  ^-  (unit @da)
  =/  ds=(list @da)
    %+  murn  ~(val by pen)
    |=(w=pub-wait ?.(dirty.w ~ `(pub-due w gap)))
  ?~  ds  ~
  =/  at=@da  (roll t.ds |:([a=*@da b=i.ds] (min a b)))
  `?:((lte at now) *@da at)
+$  pub-row    [updated=@da bytes=@ud hash=@uvH]
+$  pub-index  (map path pub-row)
::  +to-pub-row: project a stored page onto its index row.
::
++  to-pub-row
  |=  [body=@t now=@da]
  ^-  pub-row
  [now (met 3 body) (sham body)]
::  +vrail: a rail expressed structurally (== rail:tarball [p=path name=@ta]) so
::  this lib stays grubbery-free.
::
::  +follows: the set of ships we follow (one peek, always present). Just ships.
::  +sub-action: the follow-writer's poke.
::
::  +page-sub: one live per-file subscription, a specific remote page
::  (urb://ship/pax). Stored as its own grub under /sub/pages/, whose per-sub
::  keep fiber notices the moment the peer edits that page. %sub-page /
::  %unsub-page create and tear down that grub (and thus its keep).
::
+$  follows  (set @p)
+$  page-sub  [ship=@p pax=path]
+$  sub-action
  $%  [%follow ship=@p]
      [%unfollow ship=@p]
      [%sub-page =page-sub]
      [%unsub-page =page-sub]
  ==
+$  vrail  [pax=path nom=@ta]
::  +key-to-rail: a content-map key (path) -> the vault rail holding its page,
::  rooted at [base]. Strips the leading `pub` element (redundant with base) and
::  uses the key's own last element as the grub leaf, so /pub/a/gmi and
::  /pub/a/b/gmi both map cleanly (dir /a holds the file `gmi` AND the child dir
::  `b`). ~ for an empty/degenerate key (no leaf to name).
::
++  key-to-rail
  |=  [base=path key=path]
  ^-  (unit vrail)
  ::  Only a CANONICAL pub key maps: /pub/<spur…>/gmi. The leading `pub` (redundant
  ::  with base), a `gmi` leaf (what the reader always reads), and >=1 spur segment
  ::  between. Rejecting anything else keeps the map injective (a pub-less key /a/gmi
  ::  would alias /pub/a/gmi's grub) and refuses a key the reader can never read (a
  ::  non-gmi leaf) or that collapses onto the vault root (empty spur).
  ::  lent/lth guards, NOT ?~/?=. Narrowing `rest` makes +scag's possibly-empty
  ::  result nest-fail against a non-empty input type. dir = all-but-last, leaf = last.
  ?.  ?=([%pub *] key)  ~
  =/  rest=path  t.key
  =/  len=@ud  (lent rest)
  ?:  (lth len 2)  ~
  =/  n=@ud  (dec len)
  ?.  =(%gmi (snag n rest))  ~
  `[(weld base (scag n rest)) (snag n rest)]
::  +strip-pub: drop a leading `pub` element (the content map's keys are rooted
::  there, and the vault base already carries it). Left unchanged if absent.
::
++  strip-pub
  |=  key=path
  ^-  path
  ?.  ?=(^ key)  key
  ?:(=(%pub i.key) t.key key)
::  +page-name: a published page's name in the revision list, the path
::  under /pub/page its scry bindings share: vault key /pub/<name>/gmi
::  -> '/<name>'.
::
++  page-name
  |=  key=path
  ^-  @t
  (spat (snip (strip-pub key)))
::  +page-id: the unguessable last segment of a revision's scry binding,
::  /pub/page/<name>/<id>. A counter there let anyone who knew a page's
::  name walk its old revisions, and the publisher's runtime keeps serving
::  a fetched one after the cull. The id is the salted shax of the name and
::  revision: without the ship's private salt it cannot be guessed, and it
::  says nothing about the body. Deterministic, so the publisher recomputes
::  any revision's id to cull it.
::
++  page-id
  |=  [salt=@ nam=@t rev=@ud]
  ^-  @uv
  (end [3 16] (shax (jam [salt nam rev])))
::  +salt-spurs: the scry binding each revision-list row names under
::  `salt`, /pub/page/<name>/<id>. A salt rotation culls these under the
::  OLD salt once every page is grown under the new one. A name that is
::  not a path names no binding and is skipped.
::
++  salt-spurs
  |=  [salt=@ revs=(map @t [rev=@ud id=@uv])]
  ^-  (list path)
  %+  murn  ~(tap by revs)
  |=  [nam=@t rev=@ud id=@uv]
  ^-  (unit path)
  =/  inner=(unit path)  (rush nam stap)
  ?~  inner  ~
  `(snoc (weld /pub/page u.inner) (scot %uv (page-id salt nam rev)))
::  +revs-json / +json-revs: the revision list peers read, [/pub %revs],
::  as {"/<name>": {"rev": n, "id": "0v…"}}. A reader looks a page up
::  here and %keens exactly that id: remote scry has no "latest", and the
::  list is the only place the id is published. json-revs keeps what
::  parses and drops the rest: one odd row must not cost the whole list.
::
++  revs-json
  |=  revs=(map @t [rev=@ud id=@uv])
  ^-  json
  [%o (~(run by revs) rev-json)]
::  +rev-json / +json-rev: one row of the list, so a publish edits its own
::  row and leaves the rest of the list as it is
++  rev-json
  |=  [rev=@ud id=@uv]
  ^-  json
  (pairs:enjs:format ~[['rev' (numb:enjs:format rev)] ['id' s+(scot %uv id)]])
++  json-rev
  |=  v=json
  ^-  (unit [rev=@ud id=@uv])
  ?.  ?=([%o *] v)  ~
  =/  r=(unit json)  (~(get by p.v) 'rev')
  =/  d=(unit json)  (~(get by p.v) 'id')
  ?.  &(?=([~ %n *] r) ?=([~ %s *] d))  ~
  =/  rev=(unit @ud)  (rush p.u.r dem)
  =/  id=(unit @uv)  (slaw %uv p.u.d)
  ?.  &(?=(^ rev) ?=(^ id))  ~
  `[u.rev u.id]
++  json-revs
  |=  jon=json
  ^-  (map @t [rev=@ud id=@uv])
  ?.  ?=([%o *] jon)  ~
  %-  malt
  %+  murn  ~(tap by p.jon)
  |=  [k=@t v=json]
  ^-  (unit [@t @ud @uv])
  =/  r=(unit [rev=@ud id=@uv])  (json-rev v)
  ?~(r ~ `[k u.r])
::  +small-noun: does `n` have at most `cap` cells, counting a shared
::  subtree each time it is reached, the way a clam walks it? It stops once
::  past `cap`, so it costs at most `cap` steps whatever `n` claims. A
::  peer's noun can share structure so that it is small on the wire and
::  vast to a ;;(json ...) clam, which the mole around the clam cannot stop.
++  small-noun
  |=  [n=* cap=@ud]
  ^-  ?
  =/  todo=(list *)  ~[n]
  =|  seen=@ud
  |-  ^-  ?
  ?~  todo  &
  ?:  (gth seen cap)  |
  ?@  i.todo  $(todo t.todo)
  $(todo [-.i.todo +.i.todo t.todo], seen +(seen))
--
