::  mar/lattice/pub-action: a write poked at the pub writer (save-page/del-page).
::  The writer receives it as a NOUN dart (the `noun` grab); the json grab lets
::  an owner HTTP client drive a write directly.
::
/<  lp  /lib/lattice-pub.hoon
=,  format
|_  act=pub-action:lp
++  grad  %noun
++  grow
  |%
  ++  noun  act
  --
++  grab
  |%
  ++  noun  pub-action:lp
  ++  json
    |=  jon=^json
    ^-  pub-action:lp
    %.  jon
    %-  of:dejs
    :~  save-page+(ot:dejs key+so:dejs body+so:dejs ~)
        del-page+(ot:dejs key+so:dejs ~)
    ==
  ++  mime
    |=  [=mite len=@ud tex=@t]
    ^-  pub-action:lp
    =/  jon=(unit ^json)  (de:json:html tex)
    ?~  jon  ~|(%pub-action-bad-json !!)
    (json u.jon)
  --
--
