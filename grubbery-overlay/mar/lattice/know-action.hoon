::  mar/lattice/know-action: a write poked at the vault-manager fiber
::  (save/del/restore/move/tag/untag, plus import/import-trashed).
::
::  Two entry paths: the writer receives the full know-action as a NOUN dart (the
::  `noun` grab — this is how the nexus's own HTTP handlers, including the
::  bulk-import path, drive the writer); the json/mime grabs let an HTTP client
::  drive the SIMPLE actions directly —
::  POST /grubbery/api/poke/apps/lattice.lattice_app/main.sig
::  ?blot=/lattice/know-action with e.g. {"save":{"key":"/a","body":"hi"}}.
::  json deliberately omits import/import-trashed (they carry a whole know-entry
::  and only ever arrive as a noun dart, never as HTTP json).
::
/<  lk  /lib/lattice-know.hoon
=,  format
|_  act=know-action:lk
++  grad  %noun
++  grow
  |%
  ++  noun  act
  --
++  grab
  |%
  ++  noun  know-action:lk
  ++  json
    |=  jon=^json
    ^-  know-action:lk
    %.  jon
    %-  of:dejs
    :~  save+(ot:dejs key+so:dejs body+so:dejs ~)
        del+(ot:dejs key+so:dejs ~)
        restore+(ot:dejs key+so:dejs ~)
        move+(ot:dejs from+so:dejs to+so:dejs ~)
        tag+(ot:dejs key+so:dejs tag+so:dejs ~)
        untag+(ot:dejs key+so:dejs tag+so:dejs ~)
    ==
  ++  mime
    |=  [=mite len=@ud tex=@t]
    ^-  know-action:lk
    =/  jon=(unit ^json)  (de:json:html tex)
    ?~  jon  ~|(%know-action-bad-json !!)
    (json u.jon)
  --
--
