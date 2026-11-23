::  /lib/lattice-index-types: frozen types for the term index bucket mark.
::
::  Kept separate from /lib/lattice-index so tokenizer or scoring edits never
::  change mar/lattice/index-bucket and force kernel re-checks on /idx/b.
::
|%
::  +$  posts: who carries a term, and how often.
::
+$  posts   (map key=@t [scope=@t tf=@ud])
::  +$  bucket: one grub's worth of the index.
::
+$  bucket  (map term=@t posts)
--
