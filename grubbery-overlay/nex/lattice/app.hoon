::  nex/lattice/app: the %lattice knowledge vault nexus (phase-1 stage 0b).
::
::  main.sig is the ONLY writer. It takes %know-action pokes and maintains:
::    know/vault/<key>/entry   one know-entry grub per key, gain=%.y
::    know/index               derived live index  (key -> [updated bytes tags])
::    know/trash               derived trash index (soft-deleted keys)
::  Reads are served by grubbery's built-in %x/peek namespace (file/kids/tree)
::  — the %lattice gall agent is the HTTP/scry facade and converts to json.
::
::  Vault layout uses the fixed `entry` leaf under each key-dir so /a and /a/b
::  can both be entries (see /lib/lattice-know). Foreign writes/reads can't
::  reach here: the deny-all weir chain gates every cross-ship dart.
::
/<  lk  /lib/lattice-know.hoon
=<  ^-  nexus:nexus
    |%
    ++  on-load
      |=  =ball:tarball
      ^-  bole:tarball
      =/  =ver:loader  (get-ver:loader ball)
      ?+  ver  !!
          ?(~ [~ %0])
        ::  Every persistent path needs a covering row — spin rebuilds the
        ::  bole from scratch and DROPS anything uncovered. The %fall %| over
        ::  /know/vault copies the whole existing subtree, so dynamically
        ::  created entries survive reload.
        %+  spin:loader  ball
        :~  (ver-row:loader 0)
            [%fall %& [/ %'main.sig'] [[/ %sig] ~]]
            [%fall %| /know/vault empty-dir:loader]
            [%fall %& [/know %index] [[/lattice %know-index] *know-index:lk]]
            [%fall %& [/know %trash] [[/lattice %know-index] *know-index:lk]]
        ==
      ==
    ::
    ++  on-file
      |=  [=rail:tarball =blot:tarball]
      ^-  spool:fiber:nexus
      |=  =prod:fiber:nexus
      =/  m  (fiber:fiber:nexus ,~)
      ^-  process:fiber:nexus
      ?+    rail  stay:m
          [~ %'main.sig']
        ;<  ~     bind:m  (rise-wait:io prod "%lattice writer failed")
        ;<  here=rail:tarball  bind:m  get-here-abs:io
        =/  root=path  path.here
        |-
        ;<  =sage:tarball  bind:m  take-poke:io
        ?.  =([/lattice %know-action] p.sage)
          ~&  [%lattice-bad-mark p.sage]
          $
        ;<  now=@da  bind:m  get-time:io
        ;<  ~  bind:m  (apply root now !<(know-action:lk q.sage))
        $
      ==
    --
|%
::  +apply: dispatch one knowledge action. root is the nexus dir (/lattice).
::
++  apply
  |=  [root=path now=@da act=know-action:lk]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  =/  vbase=path  (weld root /know/vault)
  =/  ix=road:tarball  [%& %& (weld root /know) %index]
  =/  tx=road:tarball  [%& %& (weld root /know) %trash]
  ?-    -.act
      %save
    =/  key=path  (stab key.act)
    =/  road=road:tarball  (entry-road vbase key)
    ;<  old=(unit know-entry:lk)  bind:m  (read-entry road)
    =/  e=know-entry:lk  (merge-save:lk old body.act now)
    ;<  ~  bind:m  (ensure-dirs vbase key)
    ;<  ~  bind:m  (put-file road [/lattice %know-entry] e)
    ;<  ~  bind:m  (gain:io road %.y)
    ;<  idx=know-index:lk  bind:m  (read-index ix)
    ;<  ~  bind:m
      (put-file ix [/lattice %know-index] (~(put by idx) key (to-index-entry:lk e)))
    ::  a re-saved key leaves trash; drop any stale trash row
    ;<  trash=know-index:lk  bind:m  (read-index tx)
    ?.  (~(has by trash) key)  (pure:m ~)
    (put-file tx [/lattice %know-index] (~(del by trash) key))
  ::
      %del
    =/  key=path  (stab key.act)
    =/  road=road:tarball  (entry-road vbase key)
    ::  capture the firm cass BEFORE culling — it's the revision restore reads.
    ;<  oc=(unit [e=know-entry:lk =cass:clay])  bind:m  (read-entry-cass road)
    ?~  oc  ~&([%lattice-del-missing key] (pure:m ~))
    ::  cull tombs the grub; born keeps the firm history (gain=%.y) so the
    ::  body is recoverable. Move the index row into trash with its restore cass.
    ;<  ~  bind:m  (cull:io road)
    ;<  idx=know-index:lk  bind:m  (read-index ix)
    ;<  ~  bind:m  (put-file ix [/lattice %know-index] (~(del by idx) key))
    ;<  trash=know-index:lk  bind:m  (read-index tx)
    %-  put-file
    :*  tx  [/lattice %know-index]
        (~(put by trash) key (to-trash-entry:lk e.u.oc ud.cass.u.oc))
    ==
  ::
      %tag    (retag root key.act tag.act %.y)
      %untag  (retag root key.act tag.act %.n)
  ::
      %move
    =/  fk=path  (stab from.act)
    =/  tk=path  (stab to.act)
    =/  froad=road:tarball  (entry-road vbase fk)
    =/  troad=road:tarball  (entry-road vbase tk)
    ;<  old=(unit know-entry:lk)  bind:m  (read-entry froad)
    ?~  old  ~&([%lattice-move-missing fk] (pure:m ~))
    ::  make target first (duplicate-on-crash, never lose), cull source after.
    ;<  ~  bind:m  (ensure-dirs vbase tk)
    ;<  ~  bind:m  (put-file troad [/lattice %know-entry] u.old)
    ;<  ~  bind:m  (gain:io troad %.y)
    ;<  ~  bind:m  (cull:io froad)
    ;<  idx=know-index:lk  bind:m  (read-index ix)
    =.  idx  (~(put by (~(del by idx) fk)) tk (to-index-entry:lk u.old))
    (put-file ix [/lattice %know-index] idx)
  ::
      %restore
    =/  key=path  (stab key.act)
    ;<  trash=know-index:lk  bind:m  (read-index tx)
    =/  row=(unit index-entry:lk)  (~(get by trash) key)
    ?~  row  ~&([%lattice-restore-missing key] (pure:m ~))
    ?~  restore.u.row  ~&([%lattice-restore-no-cass key] (pure:m ~))
    ::  read the firm revision back from born history (gain=%.y kept its lobe).
    =/  road=road:tarball  (entry-road vbase key)
    ;<  =seen:nexus  bind:m  (peek-at:io road ~ [%ud u.restore.u.row])
    ?.  ?=([%& %file *] seen)
      ~&([%lattice-restore-peek-failed key] (pure:m ~))
    =/  e=know-entry:lk  !<(know-entry:lk (need-vase:tarball sang.p.seen))
    ::  re-make the entry (make-after-delete, fixed in 3124505), restore gain,
    ::  move the row back from trash to the live index.
    ;<  ~  bind:m  (ensure-dirs vbase key)
    ;<  ~  bind:m  (put-file road [/lattice %know-entry] e)
    ;<  ~  bind:m  (gain:io road %.y)
    ;<  ~  bind:m  (put-file tx [/lattice %know-index] (~(del by trash) key))
    ;<  idx=know-index:lk  bind:m  (read-index ix)
    (put-file ix [/lattice %know-index] (~(put by idx) key (to-index-entry:lk e)))
  ::
      %import
    ::  write a live entry VERBATIM (preserve updated/tags/vector) — migration,
    ::  not a user edit, so no merge-save now-stamp. Mirror of %save minus the
    ::  body merge; index row derives from the entry's own metadata.
    =/  key=path  (stab key.act)
    =/  road=road:tarball  (entry-road vbase key)
    ;<  ~  bind:m  (ensure-dirs vbase key)
    ;<  ~  bind:m  (put-file road [/lattice %know-entry] entry.act)
    ;<  ~  bind:m  (gain:io road %.y)
    ;<  idx=know-index:lk  bind:m  (read-index ix)
    ;<  ~  bind:m
      (put-file ix [/lattice %know-index] (~(put by idx) key (to-index-entry:lk entry.act)))
    ;<  trash=know-index:lk  bind:m  (read-index tx)
    ?.  (~(has by trash) key)  (pure:m ~)
    (put-file tx [/lattice %know-index] (~(del by trash) key))
  ::
      %import-trashed
    ::  land a trashed entry: write verbatim, gain, VERIFY the firm revision is
    ::  readable, THEN cull — culling a still-%.n file tomb-temps the body and
    ::  drops its silo refs (the one destructive-if-misordered step). The trash
    ::  row carries the entry's own updated/tags + the firm cass for restore.
    =/  key=path  (stab key.act)
    =/  road=road:tarball  (entry-road vbase key)
    ;<  ~  bind:m  (ensure-dirs vbase key)
    ;<  ~  bind:m  (put-file road [/lattice %know-entry] entry.act)
    ;<  ~  bind:m  (gain:io road %.y)
    ;<  oc=(unit [e=know-entry:lk =cass:clay])  bind:m  (read-entry-cass road)
    ?~  oc  ~&([%lattice-import-trashed-readback key] (pure:m ~))
    ;<  ~  bind:m  (cull:io road)
    ;<  trash=know-index:lk  bind:m  (read-index tx)
    %-  put-file
    :*  tx  [/lattice %know-index]
        (~(put by trash) key (to-trash-entry:lk entry.act ud.cass.u.oc))
    ==
  ::
      %reindex
    ::  rebuild the live index from the vault ball — repairs drift if the
    ::  derived index ever diverges from the source-of-truth entry grubs.
    ;<  =seen:nexus  bind:m  (peek:io [%& %| vbase] ~)
    ?.  ?=([%& %ball *] seen)  ~&([%lattice-reindex-no-vault ~] (pure:m ~))
    =/  entries=(map path know-entry:lk)  (collect-entries ~ ball.p.seen)
    (put-file ix [/lattice %know-index] (derive-index:lk entries))
  ==
::  +retag: %tag / %untag — touch the entry's tag set + refresh its index row.
::
++  retag
  |=  [root=path key-t=@t tag=@t add=?]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  =/  vbase=path  (weld root /know/vault)
  =/  key=path  (stab key-t)
  =/  road=road:tarball  (entry-road vbase key)
  ;<  old=(unit know-entry:lk)  bind:m  (read-entry road)
  ?~  old  ~&([%lattice-tag-missing key] (pure:m ~))
  =/  e=know-entry:lk
    ?:(add (add-tag:lk u.old tag) (del-tag:lk u.old tag))
  ;<  ~  bind:m  (put-file road [/lattice %know-entry] e)
  =/  ix=road:tarball  [%& %& (weld root /know) %index]
  ;<  idx=know-index:lk  bind:m  (read-index ix)
  (put-file ix [/lattice %know-index] (~(put by idx) key (to-index-entry:lk e)))
::  +entry-road: absolute road to a key's entry grub.
::
++  entry-road
  |=  [vbase=path key=path]
  ^-  road:tarball
  =/  vr=vrail:lk  (key-to-rail:lk vbase key)
  [%& %& pax.vr nom.vr]
::  +read-entry: peek a vault grub. ~ if absent/tombstoned.
::
++  read-entry
  |=  road=road:tarball
  =/  m  (fiber:fiber:nexus ,(unit know-entry:lk))
  ^-  form:m
  ;<  =seen:nexus  bind:m  (peek:io road ~)
  ?.  ?=([%& %file *] seen)  (pure:m ~)
  (pure:m `!<(know-entry:lk (need-vase:tarball sang.p.seen)))
::  +read-entry-cass: like read-entry but also return the live firm cass —
::  %del stashes it so %restore can peek-at the right revision.
::
++  read-entry-cass
  |=  road=road:tarball
  =/  m  (fiber:fiber:nexus ,(unit [know-entry:lk cass:clay]))
  ^-  form:m
  ;<  =seen:nexus  bind:m  (peek:io road ~)
  ?.  ?=([%& %file *] seen)  (pure:m ~)
  (pure:m `[!<(know-entry:lk (need-vase:tarball sang.p.seen)) cass.p.seen])
::  +read-index: peek an index grub. Empty if absent.
::
++  read-index
  |=  road=road:tarball
  =/  m  (fiber:fiber:nexus ,know-index:lk)
  ^-  form:m
  ;<  =seen:nexus  bind:m  (peek:io road ~)
  ?.  ?=([%& %file *] seen)  (pure:m *know-index:lk)
  (pure:m !<(know-index:lk (need-vase:tarball sang.p.seen)))
::  +put-file: create-or-overwrite a grub (over = %make force=%.y).
::
++  put-file
  |=  [road=road:tarball =blot:tarball noun=*]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ;<  exists=?  bind:m  (peek-exists:io road)
  ?:  exists  (over:io road [blot noun])
  (make:io road |+[[blot noun] ~])
::  +ensure-dirs: make each cumulative dir base/seg1, base/seg1/seg2 ... so a
::  deep key's entry has a parent. ponytail: empty key-dirs are left behind on
::  delete — add pruning if the tree clutters.
::
++  ensure-dirs
  |=  [base=path segs=path]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ?~  segs  (pure:m ~)
  =/  dir=path  (weld base /[i.segs])
  =/  road=road:tarball  [%& %| dir]
  ;<  exists=?  bind:m  (peek-exists:io road)
  ;<  ~  bind:m  ?:(exists (pure:m ~) (make:io road &+empty-dir:loader))
  $(base dir, segs t.segs)
::  +collect-entries: walk a vault ball, harvesting one know-entry per `entry`
::  grub. base = accumulated key path of the current node. Booms/non-entry
::  dirs are skipped, so this yields exactly the live keys.
::
++  collect-entries
  |=  [base=path b=ball:tarball]
  ^-  (map path know-entry:lk)
  =/  acc=(map path know-entry:lk)
    ?~  fil.b  ~
    =/  got  (~(get by contents.u.fil.b) entry-leaf:lk)
    ?~  got  ~
    ?:  (is-boom:tarball sang.u.got)  ~
    (my [base !<(know-entry:lk (need-vase:tarball sang.u.got))] ~)
  =/  kids=(list [seg=@ta kid=ball:tarball])  ~(tap by dir.b)
  |-
  ?~  kids  acc
  =.  acc  (~(uni by acc) (collect-entries (snoc base seg.i.kids) kid.i.kids))
  $(kids t.kids)
--
