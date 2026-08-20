# Grub-native term index

Own-content search runs off an inverted index stored as grubs. 256 bucket
grubs, each holding the postings for the terms that hash into it. `GET
/content-search` reads exactly one bucket per query word. `POST
/search-reindex` rewrites all 256 in a single dart.

The fanout is the whole design. A grub write rehashes its containing
directory's file map at every ancestor, so an index in ONE grub costs O(entire
corpus) per write. On a real vault that is a rebuild running for minutes with
the ship unable to serve HTTP at all. Spreading the postings over many grubs is
what buys that back.

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
   hard ceiling. This is what rules out a per-document forward index.
6. **All local darts drain inside ONE Arvo event** (`app/grubbery.hoon:915-921`).
   Only a behn timer creates an event boundary. Splitting a rebuild across
   several pokes therefore yields nothing between them. It is still one event,
   and a long one wedges HTTP rather than merely running slow. A `sleep:io` is
   the only way to break it up.

## Layout

```
/apps/lattice.lattice_app/idx/b/<name>   256 bucket grubs, b00 … bff
                                         name = "b" + hex(mug(term) % 256)
```

Fanout is 256. It sits inside the "low hundreds" rule from (2) and is small
enough that a whole-index rewrite is one bole.

Buckets live under `/idx/b`, not `/idx` directly, because `+sync-bole` deletes
anything in the target directory the bole omits. Their own covered directory
means a rebuild can never take out a sibling.

Bucket grub content: `(map term=@t posts)` where
`posts = (map key=@t [scope=@t tf=@ud])`.

Scope travels WITH the posting (`public` / `private` / `knowledge`), because
the UI badges every hit by scope. There is no separate doc registry. The key is
the identity, and scope is a field, never part of the key. Keying on `[scope
key]` would mint a second entry on a private->public flip and index the
document twice.

## What a posting is

A document body becomes a bag of words, never a copy of the body. Three lossy
stages, all in `lib/lattice-index.hoon`:

1. **Split and normalize.** `+split-space` breaks the body on runs of spaces.
   `+normalize-term` lower-cases each token, trims non-alphanumeric characters
   off both ends, and drops it if it is under 3 characters, over `term-len-max`
   (64 bytes), or in `stop-words`. Interior punctuation survives, so
   `~ricsul-bilwyt` and hyphenated words index the way a searcher types them.
2. **Dedupe to a count.** `+index-terms` folds the survivors into a frequency
   map. Positions are gone at this point.
3. **Cap.** `+top-terms` keeps the `term-max` (512) most frequent terms, ties
   broken by term order so every rebuild selects the same ones.

So a bucket holds `(term, tf)` per document key. No body text is stored, and a
posting list is an order-free projection you cannot reconstruct a page from.

Writer and reader must agree byte for byte, so `/content-search` runs its
`term` param through the same `+normalize-term` the indexer used. A term that
normalizes to nothing (too short, a stop word) answers 200 with no rows, not
400, so a client fanning one call out per query word does not error on a common
word.

The tokenizer is ASCII byte-level. It lower-cases and edge-trims ASCII only, so
accented or CJK words are mangled or dropped. Multi-word search is OR over the
query words: the reader fires one call per word, then ranks by how many words
a document matched and breaks ties on summed tf.

## Operations

| op | cost |
|---|---|
| search one term | 1 peek of 1 bucket, then a map lookup |
| full rebuild | 1 bole dart, O(R) once |

Search is one `peek` per query word regardless of corpus size. Grubbery caches
grub validation keyed by `[content-lobe, mark-ckey]`, so repeated searches over
an unchanged bucket skip the `vale` entirely.

A rebuild emits EVERY bucket, empty ones included, so deleting documents and
reindexing cannot leave a stale bucket behind holding their postings. It culls
`/idx/b` first, because `make-soft` sends `force=%.n` and a bole aimed at a
directory that already exists silently no-ops.

## Incremental writes are not implemented

Nothing updates the index in place. Page save, delete, move and share change,
and every `know` write, all leave it untouched. The single writer is the
wholesale `+content-reindex` behind `POST /search-reindex`, so results are as
fresh as the last rebuild.

Doing incremental properly needs a write-ahead delta grub plus a merge fiber
that `sleep:io`s between batches (per fact 6, without a timer the merge is one
giant event again). It also needs:

- `delta` must carry `pend=(map key (list term))`, or re-saving a document twice
  before a merge leaves it in the posting list of a term it no longer contains.
- `on-load` must re-poke a parked merge. `+on-save` replaces every live proc's
  continuation with an error tang on `|bump`, so a sleeping merge is destroyed
  while its sealed input survives on disk.

The editor covers the gap for pages open in the workspace. Its search greps the
page dump the client already holds, which is live and matches partial words,
neither of which the term index does.

## Out of scope

Incremental indexing, ranking changes, and any change to the `/content-search`
JSON response shape. The reader's inline search script consumes `columns` +
`rows` and must keep working unchanged.
