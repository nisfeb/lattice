::  /lib/lattice-eval — molds for the programmable-page evaluator
::  (docs/platform.md, build step 2).
::
::  A page is a directory under /page/<name>/ holding:
::    code  — hoon source of a gate (cord); the evaluator compiles and runs it
::    data  — the page's current value (any noun; the gate's product)
::    cmd   — the command inbox ($eval-cmd; seq bumps so repeats fire waves)
::    deps  — declared dependencies ((list path); file paths, absolute)
::    err   — last compile/run failure rendered as text ('' = healthy)
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
      [%cmd pax=path txt=@t bud=@ud]    ::  send a command (bud = poke budget)
      [%del pax=path]                   ::  delete a page
      [%share pax=path mode=share-mode] ::  set a page's sharing preset
  ==
::  +$  share-mode: a page's sharing preset (docs/platform.md step 4).
::    %private  — not gained, owner-only (default).
::    %shared   — data grub gained + public-usergroup peek: any ship reads
::                it over ames (peek-remote), live.
::    %clearweb — shared, and its data is also served over unauthenticated
::                HTTP at /apps/lattice/c/<name>.
::
+$  share-mode  ?(%private %shared %clearweb)
::  +$  eval-cmd: the command inbox grub. seq bumps per command so an
::  identical command still fires a wave (save-file suppresses no-op writes).
::  bud is the poke budget the run this command triggers may spend: a page
::  reached via another page's poke gets a decremented budget, so a poke chain
::  (or cycle) terminates at a fixed depth regardless of timing.
::
+$  eval-cmd  [seq=@ud txt=@t bud=@ud]
--
