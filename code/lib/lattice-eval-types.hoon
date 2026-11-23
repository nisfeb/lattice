::  /lib/lattice-eval-types: frozen types for stored page evaluator grubs.
::
::  Kept separate from /lib/lattice-eval so adding writer eval-action variants
::  never alters mar/lattice/eval-cmd and triggers kernel re-checks on /page.
::
|%
::  +$  form-cfg: a page's public-form limits. cap=0 means no absolute limit.
::  gap=0 means no cooldown.
::
+$  form-cfg  [cap=@ud gap=@dr]
::  +$  form-use: a page's submission tally.
::
+$  form-use  [count=@ud last=@da]
::  +$  share-mode: a page's sharing preset.
::
+$  share-mode  ?(%private %shared %clearweb)
::  +$  eval-cmd: the command inbox grub. seq bumps per command so an
::  identical command still fires a wave. bud is the poke budget.
::
+$  eval-cmd  [seq=@ud txt=@t bud=@ud]
--
