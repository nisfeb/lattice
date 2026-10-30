::  mar/lattice/link: a page shared with you, moved into your own tree
::  (see /lib/lattice-link). Noun only: tree and dump render it with
::  +en-link, and the body never leaves as JSON.
::
/<  lk  /lib/lattice-link.hoon
|_  l=link:lk
++  grad  %noun
++  grow
  |%
  ++  noun  l
  --
++  grab
  |%
  ++  noun  link:lk
  --
--
