::  mar/lattice/comment: one stored comment grub — [author when body].
::
/<  lc  /lib/lattice-comment.hoon
=,  format
|_  c=comment:lc
++  grad  %noun
++  grow
  |%
  ++  noun  c
  ++  json
    ^-  ^json
    %-  pairs:enjs
    :~  author+s+(scot %p author.c)
        when+s+(scot %da when.c)
        body+s+body.c
    ==
  --
++  grab
  |%
  ++  noun  comment:lc
  --
--
