# Grub-native term index

Replaces obelisk's `content-terms` (and later `catalog-terms`) with an inverted
index stored as grubs. Written after a full-vault `/search-reindex` took >10
minutes and left ~ricsul-bilwyt unable to serve HTTP at all.

## Why obelisk is the wrong store for this

The entire obelisk database lives in ONE grub (`db.lattice`). Every write peeks
the whole state, runs the pure `+exec`, and writes the whole state back, and
obelisk's `+update-file` rebuilds a table's primary index once per *statement*.

So a rebuild of R rows in C chunks costs ~C x O(R). Worse, saving a single
file costs O(entire corpus) once the catalog is large. Term postings are huge,
append-heavy, and only ever need `term -> [(doc, tf)]`. Catalog metadata is small,
relational, and genuinely worth querying. They have opposite access patterns and
should not share a store. Obelisk KEEPS the metadata tables. Only the postings move.

## Grubbery's cost model (measured from source on ~tyr, not assumed)

These four facts decide the whole layout:

1. **A grub write costs `sham` (jam+sha256) over the containing directory's whole
   file map, at every ancestor up to root.** See `+record-trees` -> `+put-tree`,
   `lib/nexus.hoon:510-554`. Directory WIDTH is a per-write tax. 50k term-grubs in
   one directory means every write jams a 50k-entry map.
2. **Depth is cheap, width is linear.** The axal is O(depth · log fanout) with
   structural sharing (`sys/arvo.hoon:425-505`). Prefer deep and narrow. Keep
   fanout in the low hundreds.
3. **Peeking one grub is cheap and does not materialise its parent. Peeking a
   DIRECTORY is catastrophic**, and `peek:io` defaults to deep. So search must be
   a pure name computation (term -> bucket -> one peek) and must NEVER enumerate.
4. **One `%make` dart carrying a bole writes K grubs with ONE tree hash**
   (`make:nexus` is `(each bole [bask (unit blot)])`, `+sync-bole`). O(K), not O(K²).

Two more that shaped it:

5. **Every grub holds a permanent fiber slot in `pool`** (`lib/nexus.hoon:322`),
   and `+cold-start` respawns one fiber per grub on every load. Grub COUNT is a
   hard ceiling. This is what killed the per-document forward index.
6. **All local darts drain inside ONE Arvo event** (`app/grubbery.hoon:915-921`).
   Only a behn timer creates an event boundary. My chunked `catalog-run-loop`
   pokes were therefore never separate events, which is exactly why the reindex
   wedged HTTP rather than merely being slow. The comment claiming otherwise was
   wrong and has been removed.

## Layout

```
/apps/lattice.lattice_app/idx/<bb>      256 bucket grubs, bb = mug(term) % 256
```

Fanout is 256. It sits inside the "low hundreds" rule from (2) and is small
enough that a whole-index rewrite is one bole.

Bucket grub content: `(map term=@t posts)` where
`posts = (map key=@t [scope=@t tf=@ud])`.

Scope travels WITH the posting (`public` / `private` / `knowledge` / a peer
`@p`), because the UI badges every hit by scope. There is no separate doc
registry. The key is the identity, and scope is a field, never part of the
key. Keying on `[scope key]` would mint a second entry on a private->public
flip and index the document twice.

## Operations

| op | cost |
|---|---|
| search one term | 1 peek of 1 bucket, then a map lookup |
| full rebuild | 1 bole dart, O(R) once |
| index/re-index one doc | see "incremental", below |

Search is one `peek` per query word regardless of corpus size. Grubbery caches
grub validation keyed by `[content-lobe, mark-ckey]`, so repeated searches over
an unchanged bucket skip the `vale` entirely.

## Incremental writes are deliberately NOT in this change

`content-terms` has no incremental path today. Page save, delete, move, share
change and every `know` write leave it untouched. The only writer is the
wholesale `+content-reindex`. So a rebuild-only replacement regresses nothing,
and the fast rebuild is what fixes the measured problem.

Doing incremental properly needs a write-ahead delta grub plus a merge fiber that
`sleep:io`s between batches (per fact 6, without a timer the merge is one giant
event again). It also needs, per the design critique:

- `delta` must carry `pend=(map key (list term))`, or re-saving a document twice
  before a merge leaves it in the posting list of a term it no longer contains.
- `on-load` must re-poke a parked merge. `+on-save` replaces every live proc's
  continuation with an error tang on `|bump`, so a sleeping merge is destroyed
  while its sealed input survives on disk.

That belongs in its own change. `catalog-terms` keeps using obelisk until then.
It is bounded at <=512 terms per page and is currently ~1.7k rows.

## Out of scope

Peer/catalog postings, incremental indexing, ranking changes, and any change to
the `/content-search` JSON response shape (the UI's inline search script at
app.hoon:~6284 consumes `columns` + `rows` and must keep working unchanged).
