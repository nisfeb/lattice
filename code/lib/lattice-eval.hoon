::  /lib/lattice-eval, molds for the programmable-page evaluator
::  (docs/platform.md, build step 2).
::
::  A page is a directory under /page/<name>/ holding:
::    code    hoon source of a gate (cord). The evaluator compiles and runs it
::    data    the page's current value (any noun, the gate's product)
::    cmd     the command inbox ($eval-cmd). seq bumps so repeats fire waves
::    deps    declared dependencies ((list path), file paths, absolute)
::    err     last compile/run failure rendered as text ('' = healthy)
::
::  The gate's sample (built as a typed vase by the evaluator):
::    [cmd=(unit @t) dat=(unit *) now=@da deps=(list [path *])]
::  The gate's product:
::    [dat=(unit *) dep=(list path)]
::  ~ dat means "no change". dep is the FULL dependency list each run.
::
/<  ft  /lib/lattice-forum-types.hoon
/<  ll  /lib/lattice-link.hoon
|%
::  +$  eval-action: page writes poked at the writer fiber (main.sig).
::
+$  eval-action
  $%  [%make pax=path src=@t]           ::  create a page / replace its code
      ::  +make, for a copy of a page a peer may have written (a move, a
      ::  conflict copy). The copy keeps the original's peer-written mark.
      [%make-marked pax=path src=@t]
      ::  N pages in ONE writer transaction. An upload used to be one HTTP
      ::  request (and one poke) per file, and every request pays the pier's
      ::  ~0.5s floor serially. A 20-file drop was ~20 round-trips of pure
      ::  overhead. Same per-page work, paid once.
      [%make-many pages=(list [pax=path src=@t])]
      [%cmd pax=path txt=@t bud=@ud]    ::  send a command (bud = poke budget)
      [%del pax=path]                   ::  delete a page
      ::  a move's state, copied from the pages and folders at or under
      ::  `from` to the same places under `to`: before the pages are made
      ::  there, each one's evaluator data and its comment, comet and form
      ::  flags (%carry-state); after, each page's revision history, its
      ::  comments, held comments and inbox items (%carry)
      [%carry-state from=path to=path]
      [%carry from=path to=path]
      [%share pax=path mode=share-mode] ::  set a page's sharing preset
      [%share-tree pax=path mode=share-mode] ::  set every page under pax
      ::  set (%private clears) the share setting of the FOLDER at pax,
      ::  which every page under it with none of its own takes
      [%share-dir pax=path mode=share-mode]
      ::  drop the page at pax's own share setting, so it takes its folder's
      [%share-clear pax=path]
      ::  write the `dir-index` of the folder at pax and each folder under it:
      ::  its pages' titles and times, for ships and groups granted it
      [%dir-index pax=path]
      ::  the folder at pax is shared with group `gname` (a ship's own group
      ::  for a ship) for `mode`: noted in its `share-grants`, so pages
      ::  added or moved in later are granted too (+grant-new)
      [%folder-grant pax=path gname=@t mode=@t]
      ::  the folder at pax is no longer shared with group `gname`: it
      ::  leaves the folder's `share-grants`, so pages added later stay
      ::  private (+unshare-folder takes back what it granted)
      [%folder-ungrant pax=path gname=@t]
      ::  the share notices a grant or a revoke owes (+tell-holds): each
      ::  ship told of each page it now reads (`add`) or reads no more
      [%share-tell add=(list [who=@p pax=path mode=@t]) del=(list [who=@p pax=path])]
      ::  the page at pax was shared with a ship by hand: its grant is its
      ::  own, and no folder takes it back on a move
      [%grant-own pax=path]
      ::  re-grow every published page and the index (+pub-regrow), in
      ::  the writer so no save interleaves with its revision list
      [%pub-regrow ~]
      ::  unpublish the page or folder at pub key `key` (the legacy POST
      ::  /delete), in the writer as a job like %del
      [%unpub key=@t]
      [%mkdir pax=path]                 ::  create an (empty) folder at pax
      ::  set ('' clears) the display name of a page or folder. Stored ONLY
      ::  when the typed name was not a valid path segment; a valid name is
      ::  its own display name and gets no grub.
      [%dname pax=path name=@t]
      [%tmpl-save from=path name=@tas]  ::  save page-tree `from` as template `name`
      [%tmpl-del name=@tas]             ::  delete template `name`
      [%comments pax=path on=?]         ::  turn comments on/off at pax (page or folder)
      ::  set the comet mode at pax (open, held, off; +comet-gate:lattice-share)
      [%comet-mode pax=path mode=@tas]
      ::  approve (ok=&) or reject a held comet comment on page pax
      [%comet-pending pax=path id=@ta ok=?]
      [%forms pax=path on=? cap=@ud gap=@dr]  ::  public forms: on/off + limits
      [%form-hit pax=path now=@da]      ::  record one accepted submission
      [%form-reset pax=path]            ::  zero a page's submission counter
      [%page-sensitive pax=path on=?]   ::  mark/unmark a page (or folder) sensitive
      [%legacy-seen imported=@ud]       ::  retired %lattice agent dealt with
      [%legacy-pages rels=(list path)]  ::  page rels this migration triggered
      ::  one forum action by `src`. The writer is the only place a forum
      ::  board is written. A board-level action (create/delete board, set
      ::  role/public/prune, edit info) is refused unless src is our.
      [%forum src=@p act=action:ft]
      ::  a refusal note a HOST sent back about one of our cross-ship posts,
      ::  stored under /forum/notes. Routed through the writer so the forum
      ::  inbox fiber (/forum.sig) never writes /forum itself: /main.sig is
      ::  the single writer of the whole /forum tree.
      [%forum-note-store host=@p payload=*]
      ::  a ban's cleanup: every post, comment and vote of `who` and its
      ::  moons (every comet for +all-comets:ls) off every board we host
      [%forum-cull who=@p]
      ::  the owner clears every stored refusal note (frees the 100-note cap).
      [%forum-notes-clear ~]
      ::  the owner read activity items (lib/lattice-notify): these ids, or
      ::  every item so far when ids is empty
      [%notify-read ids=(list @ta)]
      ::  the owner turns comet posting on or off for one board, and the
      ::  published list of boards that take comet posts follows
      [%forum-comets name=@ta on=?]
      ::  write a link (/lib/lattice-link) at /page/<pax>/link, making its
      ::  dir. Through the writer like every page-tree write, so it lands
      ::  in order with a move's mkdirs and bumps the change beacon.
      [%link-put pax=path =link:ll]
      ::  a live read of the link at /page/<pax> naming `rpax` on `host`:
      ::  `got` its [kind body rev], ~ when it failed. Applied in the writer
      ::  only while that same link is still there, so a read that finishes
      ::  after a move or delete never brings it back.
      [%link-seen pax=path host=@p rpax=path got=(unit [kind=@ta body=@t rev=@ud])]
  ==
::  +$  form-cfg: a page's public-form limits. cap=0 means no absolute limit.
::  gap=0 means no cooldown. Set by the owner (page-forms), read by serve-form
::  with the same nearest-wins walk as the on/off flag, so a folder can carry
::  the policy for a whole site.
+$  form-cfg  [cap=@ud gap=@dr]
::  +$  form-use: a page's submission tally. Per-page and exact (never
::  inherited). A folder-level cap that shared one counter across every page
::  under it would be surprising in both directions.
+$  form-use  [count=@ud last=@da]
::  +$  share-mode: a page's sharing preset (docs/platform.md step 4).
::    %private    not gained, owner-only (default).
::    %shared     data grub gained + public-usergroup peek. Any ship reads
::                it over ames (peek-remote), live.
::    %clearweb   shared, and its data is also served over unauthenticated
::                HTTP at /apps/lattice/c/<name>.
::
+$  share-mode  ?(%private %shared %clearweb)
::  +$  eval-cmd: the command inbox grub. seq bumps per command so an
::  identical command still fires a wave (save-file suppresses no-op writes).
::  bud is the poke budget the run this command triggers may spend. A page
::  reached via another page's poke gets a decremented budget, so a poke chain
::  (or cycle) terminates at a fixed depth regardless of timing.
::
+$  eval-cmd  [seq=@ud txt=@t bud=@ud]
--
