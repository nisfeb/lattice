::  /lib/lattice-comment — molds for page comments (Urbit-ships-only).
::
::  A comment is a small grub under /comments/<page>/<id>, authored by the POKING
::  ship (taken from the poke SOURCE via get-poke-src — cryptographic, never
::  self-reported, so it can't be spoofed). Page content under /page/ stays
::  owner-only; the public comments fiber's poke weir is the only door open to
::  other ships, and it reaches only /comments/. So a commenter can append a
::  comment but structurally cannot edit a page.
::
|%
::  +$  comment: one stored comment grub.
::
+$  comment  [author=@p when=@da body=@t]
::  +$  comment-action: the poke payload a commenter sends. `author` is NOT
::  carried here — the receiver takes it from the poke source. body is length-
::  capped and HTML-escaped by the receiver/renderer.
::
+$  comment-action  [page=path body=@t]
::  +max-body: comment length cap (bytes). Bounds storage + render of a hostile
::  commenter, like the peer-page data cap.
::
++  max-body  ^-(@ud 4.096)
--
