::  /sur/lattice - structures for %lattice
::
|%
+$  state-0
  $:  %0
      published=(map path @uvH)         ::  /lib path → content hash (sham)
      pending=(map @ta [=ship =path])    ::  eyre-id → in-flight remote fetch
  ==
::  state-1 adds subscriptions: a followed remote file and the last revision
::  seen, so the follow-loop keens `last+1` (pends until the next %grow).
+$  state-1
  $:  %1
      published=(map path @uvH)
      pending=(map @ta [=ship =path])
      subs=(map [=ship spur=path] last=@ud)
  ==
::  state-2 adds `fetches`: in-flight walk-to-latest fetches. Remote scry has no
::  "latest" query, so a no-rev fetch keens rev 1,2,3… (recording the highest
::  resolved content) until the next rev pends; a behn timer (deadline) fires
::  when the walk stalls, and we answer with the best revision seen.
+$  state-2
  $:  %2
      published=(map path @uvH)
      pending=(map @ta [=ship =path])
      subs=(map [=ship spur=path] last=@ud)
      fetches=(map @ta walk)
  ==
::  state-3 adds `manifest`: the hash of the last-grown discovery manifest (a
::  publication at a reserved spur listing this ship's files). Growing it only
::  when the file set changes lets a remote ship probe `urb://ship/<manifest>`
::  to discover whether the ship publishes — there's no other "does this ship
::  publish" query. 0 = never grown.
+$  state-3
  $:  %3
      published=(map path @uvH)
      pending=(map @ta [=ship =path])
      subs=(map [=ship spur=path] last=@ud)
      fetches=(map @ta walk)
      manifest=@uvH
  ==
::  state-4 adds `home`: the hash of the last-grown home page, grown at the
::  *empty* spur. A remote `urb://~ship/` keens the empty spur, and nothing else
::  publishes there (files live at /index, /manifest, /shared/…), so without
::  this the home keen pends forever → "no response from peer". 0 = never grown.
+$  state-4
  $:  %4
      published=(map path @uvH)
      pending=(map @ta [=ship =path])
      subs=(map [=ship spur=path] last=@ud)
      fetches=(map @ta walk)
      manifest=@uvH
      home=@uvH
  ==
::  state-5 adds `browse`: a single transient watch on the remote page the user
::  is currently viewing. After a no-rev fetch answers (best-so-far), we keep
::  keening upward from there and push each newer revision to /updates — so a
::  raced/stale first paint silently upgrades to the latest, and live edits
::  appear while viewing. `rev` is the highest rev pushed; the open keen is
::  rev+1. Replaced on each new browse, not persisted across upgrades.
+$  state-5
  $:  %5
      published=(map path @uvH)
      pending=(map @ta [=ship =path])
      subs=(map [=ship spur=path] last=@ud)
      fetches=(map @ta walk)
      manifest=@uvH
      home=@uvH
      browse=(unit [=ship spur=path rev=@ud])
  ==
::  one in-flight walk-to-latest fetch (keyed by eyre-id).
::  rev = highest revision resolved so far (0 = none yet); deadline = the armed
::  behn timer's wake time (tracked so progress can %rest + re-arm it).
+$  walk
  $:  =ship
      spur=path
      rev=@ud
      mark=@t
      body=@t
      deadline=@da
  ==
--
