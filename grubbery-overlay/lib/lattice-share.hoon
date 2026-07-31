::  /lib/lattice-share — cross-ship share notices.
::
::  When you share a file with a ship, they have no way to know: a weir grant
::  is invisible to the grantee. So the granting side sends a small NOTICE
::  poke, and the recipient keeps a "shared with me" list. The list is a set
::  of claims, not capabilities — the weir is the only authority, a notice can
::  be stale (revoked since) or spurious (never granted), and opening the
::  entry is what proves it either way. That is also why entries are capped
::  and removable: this is a bookmark list a stranger can append to.
::
|%
::  +$  action: what arrives at the shares inbox.
::
::  The sender's identity is NEVER in here — the inbox takes it from the poke's
::  transport (+get-poke-src), the same rule the comment design records. %del
::  is the owner's own curation and is refused from foreign ships.
+$  action
  $%  [%add pax=path mode=@t]          ::  mode: 'read' | 'edit'
      [%del host=@p pax=path]
  ==
+$  entry   [host=@p pax=path mode=@t when=@da]
+$  shared  (list entry)               ::  newest first
::  +cap: list bound. Anyone may poke the inbox, so without a cap a hostile
::  ship grows the grub without limit; with one they can at worst churn it.
++  cap  ^-(@ud 200)
::  +put-entry: dedupe on [host pax] (a re-share updates mode and timestamp,
::  it does not duplicate), prepend, cap.
++  put-entry
  |=  [cur=shared new=entry]
  ^-  shared
  ::  bind before the wet gate: scag casts through its argument's type, and the
  ::  raw [new (skip ...)] cell types as a lest — which cannot be ~, so the
  ::  cast mull-grows. The face widens it back to (list entry) first.
  =/  all=shared
    :-  new
    %+  skip  cur
    |=(e=entry &(=(host.e host.new) =(pax.e pax.new)))
  (scag cap all)
::  +del-entry: drop one [host pax].
++  del-entry
  |=  [cur=shared host=@p pax=path]
  ^-  shared
  %+  skip  cur
  |=(e=entry &(=(host.e host) =(pax.e pax)))
--
