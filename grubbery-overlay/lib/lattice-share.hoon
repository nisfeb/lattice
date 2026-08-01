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
::  +$  banned: ships this ship refuses. A DENY list, and deny is the one thing
::  grubbery weirs cannot express — a weir is a SET of granted roads, unioned
::  across every usergroup a ship belongs to, so there is nowhere to write "not
::  this one". The banlist therefore lives here and is enforced by this app, at
::  the two places a foreign ship's identity is actually known:
::
::    - the shares inbox, which /public deliberately lets ANY ship poke
::    - any grant this app writes (per-ship share, or a group's ship list)
::
::  What it CANNOT do, and must not pretend to: stop a banned ship reading a
::  page you published. A published page's road sits in /public's peek set,
::  which means everyone, and clearweb has no ship identity at all. Banning is
::  about who can reach you and who can hold a grant — unpublish to stop a
::  read.
+$  banned  (set @p)
::  +ban-cap: bound, same reasoning as +cap — a list the owner grows by hand,
::  but bounded so a runaway client cannot balloon the grub.
++  ban-cap  ^-(@ud 500)
::  +is-banned: the single predicate every enforcement point calls, so a new
::  call site cannot invent its own subtly different rule.
++  is-banned
  |=  [bans=banned who=@p]
  ^-  ?
  (~(has in bans) who)
--
