::  mar/lattice/bookmarks: the stored bookmark list grub (newest first).
::
/<  lb  /lib/lattice-bookmark.hoon
=,  format
|_  bs=bookmarks:lb
++  grad  %noun
++  grow
  |%
  ++  noun  bs
  ++  json
    ^-  ^json
    :-  %a
    %+  turn  bs
    |=  b=bookmark:lb
    (pairs:enjs ~[url+s+url.b title+s+title.b])
  --
++  grab
  |%
  ++  noun  bookmarks:lb
  --
--
