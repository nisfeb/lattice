::  /lib/lattice-share-types: frozen types for sharing, banlist, follow, and
::  access-request marks.
::
::  Kept separate from /lib/lattice-share so logic changes never alter a mark's
::  code and trigger kernel re-checks on stored grubs on deploy.
::
|%
::  +$  action: what arrives at the shares inbox. Sender identity comes from
::  the poke transport, never from this payload.
::
+$  action
  $%  [%add pax=path mode=@t]          ::  mode: 'read' | 'edit'
      [%dir pax=path mode=@t]          ::  a folder, by its dir-index
      [%del host=@p pax=path]
      [%put host=@p pax=path mode=@t]
  ==
+$  entry   [host=@p pax=path mode=@t when=@da]
+$  shared  (list entry)               ::  newest first
::  +$  banned: ships this ship refuses.
::
+$  banned  (set @p)
::  +$  title-row: one page's change timestamp and title in a folder index.
::
+$  title-row  [when=@ud title=@t]
::  +$  fold-action: what the writer does to followed folders.
::
+$  fold-action
  $%  [%add host=@p rel=path rows=(unit (map @t title-row))]
      [%read host=@p rel=path rows=(unit (map @t title-row))]
      [%del host=@p rel=path]
      [%seen host=@p rel=path key=@t]
  ==
::  +$  ask: what /access.sig takes.
::
+$  ask
  $%  [%ask pax=path note=@t]            ::  asker to host
      [%nay pax=path]                    ::  host to asker: declined
      [%sent host=@p pax=path note=@t]   ::  own: an ask went out
      [%took host=@p pax=path]           ::  own: the host granted edit
      [%answer who=@p pax=path ok=?]     ::  own: we decided an ask
  ==
--
