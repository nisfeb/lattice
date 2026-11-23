::  /lib/lattice-skills-types: frozen types for the skill store marks.
::
::  Kept separate from /lib/lattice-skills so skill marks never import
::  /lib/lattice-know or skill validation logic.
::
|%
+$  skill
  $:  body=@t                 ::  SKILL.md
      files=(map @t @t)       ::  relative path to text
      updated=@da
      tags=(set @t)
  ==
::  the writer's actions. %save puts one file (SKILL.md sets the body), and
::  a new skill starts with SKILL.md. %drop removes one file.
::
+$  skill-action
  $%  [%save name=@t path=@t body=@t when=@da]
  ::  %save of a new skill only: refused when the name is taken by then
      [%make name=@t path=@t body=@t when=@da]
  ::  an agent key's %save, by key id: the writer checks it again
      [%ksave name=@t path=@t body=@t when=@da kid=@t]
      [%drop name=@t path=@t]
      [%del name=@t]
      [%restore name=@t]
      [%tag name=@t tag=@t]
      [%untag name=@t tag=@t]
  ==
--
