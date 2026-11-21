::  lattice-floor: where each grub's own history starts in its path's.
::  Grubbery keeps one history per path, and a firm version outlives a
::  delete, so a page or memory made at a name used before would show
::  the old one's versions. Its floor is the top rev the earlier grub left
::  there, and only revs above it are the current grub's.
::
::  Its own lib, imported by the app alone and by no mark: a mark whose
::  code changes makes the kernel re-check and write again every grub of
::  that mark, the deleted ones too, so lib/lattice-know stays as it was.
|%
::  +in-life: is `ud` the current grub's? No floor: all revs are.
++  in-life
  |=  [floor=(unit @ud) ud=@ud]
  ^-  ?
  ?~(floor & (gth ud u.floor))
::  +floor-put: record `top` as the floor at `key`. A floor only rises:
::  a lower one would hand an earlier grub's versions back.
++  floor-put
  |=  [fl=(map path @ud) key=path top=@ud]
  ^-  (map path @ud)
  =/  was=(unit @ud)  (~(get by fl) key)
  ?:  &(?=(^ was) (gte u.was top))  fl
  (~(put by fl) key top)
--
