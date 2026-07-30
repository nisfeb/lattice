::  mar/lattice/index-bucket: one bucket of the grub-native term index.
::
::  A bucket is term -> (key -> [scope tf]). There is deliberately no json arm:
::  these grubs are an internal index, never served, and a json conversion would
::  invite something to peek the /idx DIRECTORY to render it — which is the one
::  access pattern this layout cannot afford (see docs/native-index.md).
::
/<  li  /lib/lattice-index.hoon
|_  bk=bucket:li
++  grad  %noun
++  grow
  |%
  ++  noun  bk
  --
++  grab
  |%
  ++  noun  bucket:li
  --
--
