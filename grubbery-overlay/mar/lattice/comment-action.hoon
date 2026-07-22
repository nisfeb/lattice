::  mar/lattice/comment-action: a comment poke payload — [page body]. The author
::  is taken from the poke source by the receiver, NEVER from this payload.
::
/<  lc  /lib/lattice-comment.hoon
|_  a=comment-action:lc
++  grad  %noun
++  grow
  |%
  ++  noun  a
  --
++  grab
  |%
  ++  noun  comment-action:lc
  --
--
