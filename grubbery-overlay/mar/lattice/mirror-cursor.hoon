::  mar/lattice/mirror-cursor: the reconciler's per-source memory
::  (docs/obelisk-mirror.md section 5). Carried as a bare noun on
::  purpose: the reader owns shape versioning (+read-mirror-cursor
::  clams new then v1 then default), and a typed marc here re-validates
::  every persisted cursor against the LIVE type at read time, which
::  booms old grubs on any shape change and silently converts a deploy
::  into a full-store backfill. That backfill pinned the dev ship for
::  hours before this marc learned better.
::
|_  cur=*
++  grad  %noun
++  grow
  |%
  ++  noun  cur
  --
++  grab
  |%
  ++  noun  *
  --
--
