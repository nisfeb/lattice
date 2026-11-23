::  /lib/lattice-comment-types: frozen types for page comment marks.
::
::  Kept separate from /lib/lattice-comment so comment marks never import
::  /lib/lattice-share or comment logic, avoiding kernel re-checks on deploy.
::
|%
::  +$  comment: one stored comment grub.
::
+$  comment  [author=@p when=@da body=@t]
::  +$  comment-action: the poke payload a commenter sends. author is never
::  carried here. The receiver takes it from the poke source.
::
+$  comment-action  [page=path body=@t]
--
