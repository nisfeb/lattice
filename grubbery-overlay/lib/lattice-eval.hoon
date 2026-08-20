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
|%
::  +$  eval-action: page writes poked at the writer fiber (main.sig).
::
+$  eval-action
  $%  [%make pax=path src=@t]           ::  create a page / replace its code
      ::  N pages in ONE writer transaction. An upload used to be one HTTP
      ::  request (and one poke) per file, and every request pays the pier's
      ::  ~0.5s floor serially. A 20-file drop was ~20 round-trips of pure
      ::  overhead. Same per-page work, paid once.
      [%make-many pages=(list [pax=path src=@t])]
      [%cmd pax=path txt=@t bud=@ud]    ::  send a command (bud = poke budget)
      [%del pax=path]                   ::  delete a page
      [%share pax=path mode=share-mode] ::  set a page's sharing preset
      [%share-tree pax=path mode=share-mode] ::  set every page under pax
      [%mkdir pax=path]                 ::  create an (empty) folder at pax
      [%tmpl-save from=path name=@tas]  ::  save page-tree `from` as template `name`
      [%tmpl-del name=@tas]             ::  delete template `name`
      [%comments pax=path on=?]         ::  turn comments on/off at pax (page or folder)
      [%forms pax=path on=? cap=@ud gap=@dr]  ::  public forms: on/off + limits
      [%form-hit pax=path now=@da]      ::  record one accepted submission
      [%form-reset pax=path]            ::  zero a page's submission counter
      [%legacy-seen imported=@ud]       ::  retired %lattice agent dealt with
      [%legacy-pages rels=(list path)]  ::  page rels this migration triggered
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
