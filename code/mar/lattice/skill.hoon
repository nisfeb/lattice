::  mar/lattice/skill: one stored skill (/skills/vault/<name>/skill), its
::  SKILL.md and files. Payload is +skill in lib/lattice-skills.
::
/<  lsk  /lib/lattice-skills.hoon
|_  s=skill:lsk
++  grad  %noun
++  grow
  |%
  ++  noun  s
  --
++  grab
  |%
  ++  noun  skill:lsk
  --
--
