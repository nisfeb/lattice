::  /lib/lattice-index — the grub-native inverted index.
::
::  Replaces obelisk's content-terms table. See docs/native-index.md for the cost
::  model this layout is derived from; the short version is that obelisk keeps its
::  whole database in ONE grub, so every write costs O(entire corpus), and a full
::  reindex of a real vault took over ten minutes and wedged the ship's HTTP.
::
::  The index is 256 bucket grubs under /idx, each holding the postings for the
::  terms that hash into it. Two grubbery facts pin that number down:
::
::    - a grub write re-hashes its whole directory's file map at every ancestor
::      (nexus.hoon:510-554), so directory WIDTH is a per-write tax. 256 keeps the
::      fanout in the low hundreds.
::    - peeking one grub is cheap, peeking a DIRECTORY is not. So a lookup must be
::      a pure name computation and must never enumerate the directory.
::
|%
::  +$  posts: who carries a term, and how often.
::
::  Keyed by the document key ALONE. Scope is a field, never part of the key: a
::  page flipping private -> public must move, not fork, or the document ends up
::  indexed twice under two identities.
+$  posts  (map key=@t [scope=@t tf=@ud])
::  +$  bucket: one grub's worth of the index.
+$  bucket  (map term=@t posts)
::  +buckets: how many. Fanout of the /idx directory, so it is a write cost.
++  buckets  ^-(@ud 256)
::  +bucket-of: which bucket a term lives in.
::
::  mug is a cheap 31-bit hash and its low bits are well mixed, which is all this
::  needs — the index never iterates buckets in order, so distribution is the only
::  property that matters.
++  bucket-of
  |=  term=@t
  ^-  @ud
  (mod (mug term) buckets)
::  +bucket-name: the grub name for a bucket, zero-padded so every name is the
::  same width and the directory reads sensibly.
++  bucket-name
  |=  n=@ud
  ^-  @ta
  =/  h=tape  (trip (scot %ux n))
  ::  scot %ux gives "0x1f"; keep the digits and pad to two
  =/  d=tape  (slag 2 h)
  (crip (weld ?:((gth 2 (lent d)) "b0" "b") d))
::  +name-of: the grub name a term resolves to. One call, no directory read —
::  this is the whole reason search is O(1) in corpus size.
++  name-of
  |=  term=@t
  ^-  @ta
  (bucket-name (bucket-of term))
::  +all-names: every bucket name, for building a full rebuild's bole.
++  all-names
  ^-  (list @ta)
  =/  i=@ud  0
  =|  out=(list @ta)
  |-  ^-  (list @ta)
  ?:  =(i buckets)  (flop out)
  $(i +(i), out [(bucket-name i) out])
::  +group: fold flat (scope, key, term, tf) rows into bucket-name -> bucket.
::
::  Used by the rebuild, which holds the whole corpus in hand exactly once and
::  then emits it as a single bole. Buckets with no terms are still emitted by the
::  caller, so a rebuild always REPLACES the full set rather than leaving stale
::  grubs behind from a previous, larger corpus.
++  group
  |=  rows=(list [scope=@t key=@t term=@t tf=@ud])
  ^-  (map @ta bucket)
  %+  roll  rows
  |=  [r=[scope=@t key=@t term=@t tf=@ud] acc=(map @ta bucket)]
  ^-  (map @ta bucket)
  =/  nm=@ta  (name-of term.r)
  =/  bk=bucket  (~(gut by acc) nm *bucket)
  =/  ps=posts   (~(gut by bk) term.r *posts)
  ::  last write wins on a duplicate (key, term); the analyzer already dedupes
  ::  per document, so a collision here means two documents share a key, which
  ::  the caller's own key construction prevents.
  =.  ps  (~(put by ps) key.r [scope.r tf.r])
  (~(put by acc) nm (~(put by bk) term.r ps))
::  +look: every document carrying `term`, from an already-peeked bucket.
++  look
  |=  [bk=bucket term=@t]
  ^-  (list [scope=@t key=@t tf=@ud])
  =/  ps=posts  (~(gut by bk) term *posts)
  %+  turn  ~(tap by ps)
  |=  [key=@t scope=@t tf=@ud]
  [scope key tf]
--
