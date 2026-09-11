::  mar/lattice/sub-follows: the crawler's follow set (ships to sweep). One
::  always-present grub at /sub/follows; json grow lets the HTTP client read it.
::
/<  lp  /lib/lattice-pub.hoon
=,  format
|_  fs=follows:lp
++  grad  %noun
++  grow
  |%
  ++  noun  fs
  ++  json
    ^-  ^json
    a+(turn ~(tap in fs) |=(s=@p s+(scot %p s)))
  --
++  grab
  |%
  ++  noun  follows:lp
  --
--
