::  /lib/lattice-know-types: frozen types for the knowledge vault marks.
::
::  Kept separate from /lib/lattice-know so logic edits to ranking, parsing,
::  or search never change a mark's code and force the kernel to re-check
::  every stored know grub on deploy.
::
|%
+$  know-vector  [model=@t dim=@ud vec=(list @rd)]
+$  know-entry
  $:  body=@t
      updated=@da
      tags=(set @t)
      vector=(unit know-vector)
  ==
::  programmatic knowledge actions (poked at the vault-manager fiber).
::
+$  know-action
  $%  [%save key=@t body=@t]
  ::  an agent key's save, by key id. The route checked a read that may
  ::  be stale by now, so the writer checks again against the entry it
  ::  is about to replace (+apply in the app).
      [%key-save key=@t body=@t kid=@t]
      [%del key=@t]
      [%restore key=@t]
      [%move from=@t to=@t]
      [%tag key=@t tag=@t]
      [%untag key=@t tag=@t]
  ::  verbatim imports (used by the bulk-import endpoint, POST /know-import).
  ::  Unlike %save, these write the entry VERBATIM, preserving its original
  ::  updated/tags/vector, instead of stamping updated=now. %import lands a
  ::  live entry. %import-trashed lands it then soft-deletes (so it sits in
  ::  trash, body recoverable).
      [%import key=@t entry=know-entry]
      [%import-trashed key=@t entry=know-entry]
  ==
::  derived per-entry index row for the trash listing (know-trash). Lists
::  soft-deleted entries without reading bodies. bytes = body byte-length.
::  restore is reserved for a future revision-restore feature.
::
+$  index-entry  [updated=@da bytes=@ud tags=(set @t) restore=(unit @ud)]
+$  know-index   (map path index-entry)
::  +$  doc: an entry as ranking sees it. The key counts twice and each tag
::  once, over the body's terms; front matter is not ranked.
::
+$  doc  [key=path tf=(map @t @ud) len=@ud]
::  +$  term-cache: each entry's doc, as of its updated time and tags.
::
+$  term-row    [updated=@da tags=(set @t) =doc sup=? sen=?]
+$  term-cache  (map path term-row)
--
