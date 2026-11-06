::  mar/lattice/skill-action: a skill write poked at the writer. Noun only:
::  the HTTP routes check and stamp every save before it gets here.
::
/<  lsk  /lib/lattice-skills.hoon
|_  act=skill-action:lsk
++  grad  %noun
++  grow
  |%
  ++  noun  act
  --
++  grab
  |%
  ++  noun  skill-action:lsk
  --
--
