::  mar/lattice/know-terms: each memory's ranking terms (+term-cache:lk),
::  kept so a search reads one grub instead of tokenizing the store. Every
::  reader checks a row against its entry, so a stale row is only slower.
::
/<  lk  /lib/lattice-know.hoon
|_  tc=term-cache:lk
++  grad  %noun
++  grow
  |%
  ++  noun  tc
  --
++  grab
  |%
  ++  noun  term-cache:lk
  --
--
