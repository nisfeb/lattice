::  /lib/lattice-index, the grub-native inverted index.
::
::  See docs/native-index.md for the cost model this layout is derived from. The
::  short version is that a single-grub index costs O(entire corpus) per write,
::  which on a real vault means a reindex that runs for minutes and wedges the
::  ship's HTTP. Spreading the postings over many grubs is what buys that back.
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
::  Keyed by the document key ALONE. Scope is a field, never part of the key. A
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
::  needs. The index never iterates buckets in order, so distribution is the only
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
  ::  scot %ux gives "0x1f". Keep the digits and pad to two
  =/  d=tape  (slag 2 h)
  (crip (weld ?:((gth 2 (lent d)) "b0" "b") d))
::  +name-of: the grub name a term resolves to. One call, no directory read.
::  This is the whole reason search is O(1) in corpus size.
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
  ::  last write wins on a duplicate (key, term). The analyzer already dedupes
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
::  ── tokenization ─────────────────────────────────────────────────────
::
::  A document body becomes a bag of words: split on spaces, normalize each
::  token, count what survives, keep the top-N. Three lossy stages, which is
::  what makes the index a bag of words rather than a copy of the body.
::
::  Per-document cap on postings. Only the top-`term-max` terms by frequency are
::  kept (ties broken by term order, for determinism). This bounds the per-page
::  fan-out into the buckets.
++  term-max     ^-(@ud 512)
::  +index-terms: fold every content word in [t] into the frequency map [m].
::  Dropped tokens (too short / stop word) never enter the map. Surviving
::  tokens bump their count. This is the dedup-to-count (bag-of-words) stage.
::
::  A token goes in whole, so ricsul-bilwyt and foo.hoon are found as
::  typed, and also by its parts, the runs of word bytes in it. Whole
::  tokens alone hid every word that touches punctuation inside its
::  token: the text of a markdown link is glued to its url, and
::  client/server, name=value and [[notes/todo]] are one token each. A
::  query word is still looked up whole (+query-terms), and now meets
::  the part.
++  index-terms
  |=  [m=(map @t @ud) t=tape]
  ^-  (map @t @ud)
  =/  toks=(list tape)  (split-space t)
  |-  ^-  (map @t @ud)
  ?~  toks  m
  =/  nt=(unit @t)  (normalize-term i.toks)
  =/  ps=(list @t)
    %+  skip  (murn (word-runs i.toks) normalize-term)
    |=(p=@t =(`p nt))
  =/  ws=(list @t)  ?~(nt ps [u.nt ps])
  %=  $
    toks  t.toks
    m     (roll ws |=([w=@t n=_m] (~(put by n) w +((~(gut by n) w 0)))))
  ==
::  +word-runs: the maximal runs of word bytes in a token
++  word-runs
  |=  t=tape
  ^-  (list tape)
  =|  [cur=tape out=(list tape)]
  |-  ^-  (list tape)
  ?~  t  (flop ?~(cur out [(flop cur) out]))
  =/  hp=@ud  (high-punct t)
  ?.  =(0 hp)  $(t (slag hp `tape`t), cur ~, out ?~(cur out [(flop cur) out]))
  ?:  (is-alnum i.t)  $(t t.t, cur [i.t cur])
  $(t t.t, cur ~, out ?~(cur out [(flop cur) out]))
::  +query-terms: the index terms a search query asks for, by the same
::  split and normalization the indexer uses (+index-terms), in the order
::  typed, each once. The omnibar used to split its query in the browser
::  on every non-alphanumeric byte, so ricsul-bilwyt and foo.hoon, which
::  the index holds whole, were asked for in pieces and never matched.
++  query-terms
  |=  t=tape
  ^-  (list @t)
  =|  [seen=(set @t) out=(list @t)]
  =/  toks=(list tape)  (split-space t)
  |-  ^-  (list @t)
  ?~  toks  (flop out)
  =/  nt=(unit @t)  (normalize-term i.toks)
  ?:  |(?=(~ nt) (~(has in seen) u.nt))  $(toks t.toks)
  $(toks t.toks, seen (~(put in seen) u.nt), out [u.nt out])
::  +top-terms: the [n] highest-frequency postings from [m], frequency-
::  descending, ties broken by term order so the output is deterministic
::  (and so the top-N cap selects the same terms on every rebuild).
++  top-terms
  |=  [n=@ud m=(map @t @ud)]
  ^-  (list [term=@t tf=@ud])
  %+  scag  n
  %+  sort  ~(tap by m)
  |=  [a=[t=@t f=@ud] b=[t=@t f=@ud]]
  ^-  ?
  ?:  =(f.a f.b)  (lth t.a t.b)
  (gth f.a f.b)
::  +split-space: split a tape on runs of whitespace (a space, or any
::  control byte: a newline, CR or tab). Empty segments dropped. In-order.
::  No flop needed at the caller. Spaces alone glued the last word of a
::  line to the first of the next, so neither could be found.
++  split-space
  |=  t=tape
  ^-  (list tape)
  =|  out=(list tape)
  =|  cur=tape
  |-  ^-  (list tape)
  ?~  t
    ?:  =(~ cur)  (flop out)
    (flop [(flop cur) out])
  ?:  (lte i.t ' ')
    ?:  =(~ cur)  $(t t.t)
    $(t t.t, cur ~, out [(flop cur) out])
  $(t t.t, cur [i.t cur])
::  ── term normalization ───────────────────────────────────────────────
::
::  How a raw token becomes an index term. Writers and readers must agree
::  byte for byte, so both the indexer and every search route call +normalize-term
::  rather than doing their own lower-casing.
::
::  Upper bound on a SINGLE term's byte length. A hostile page with one giant
::  space-free run would otherwise store a multi-KB "term". Real search words are
::  short. Bytes, not codepoints, a crude DoS guard that keeps any one value
::  bounded.
++  term-len-max  ^-(@ud 64)
::  +normalize-term: lower-case a raw token, strip leading/trailing
::  punctuation, and drop it (~) if shorter than 3 chars or a stop word.
::  Interior punctuation is kept, so `~ricsul-bilwyt` and hyphenated words
::  survive as a searcher would type them.
++  normalize-term
  |=  tok=tape
  ^-  (unit @t)
  =/  trimmed=tape  (trim-punct (cass tok))
  ?:  (lth (lent trimmed) 3)  ~
  ?:  (gth (lent trimmed) term-len-max)  ~      ::  drop adversarial giant tokens
  =/  c=@t  (crip trimmed)
  ?:  (~(has in stop-words) c)  ~
  `c
::
::  +trim-punct: drop non-word characters from BOTH ends of a tape: what
::  is left runs from its first word byte to its last. Punctuation past
::  ASCII (+high-punct) is skipped a character at a time.
++  trim-punct
  |=  t=tape
  ^-  tape
  =|  [i=@ud a=(unit @ud) b=@ud]
  =/  s=tape  t
  |-  ^-  tape
  ?~  s  ?~(a ~ (swag [u.a (sub b u.a)] t))
  =/  hp=@ud  (high-punct s)
  ?.  =(0 hp)  $(s (slag hp `tape`s), i (add i hp))
  ?.  (is-alnum i.s)  $(s t.s, i +(i))
  $(s t.s, i +(i), a ?~(a `i a), b +(i))
::  +is-alnum: is [c] a word byte: an ASCII letter or digit, or a byte
::  of a character past ASCII? Without the last, text in any script but
::  Latin was indexed nowhere, and "café" as "caf".
++  is-alnum
  |=  c=@tD
  ^-  ?
  ?|  &((gte c '0') (lte c '9'))
      &((gte c 'a') (lte c 'z'))
      &((gte c 'A') (lte c 'Z'))
      (gte c 128)
  ==
::  +high-punct: how many bytes of punctuation past ASCII `t` starts with,
::  0 for none. A byte of 128 or more is a word byte, so a word in any
::  script is a term. These characters are the exceptions, and separate
::  words as their ASCII twins do: U+0080 to U+00BF (no-break space,
::  guillemets), U+2000 to U+2BFF (dashes, curly quotes, the ellipsis,
::  arrows, symbols), U+3000 to U+303F (CJK punctuation) and the emoji
::  from U+1F000. /lib/lattice-know has the same arm:
::  the two tokenizers agree on it.
++  high-punct
  |=  t=tape
  ^-  @ud
  ?.  ?=([@ @ *] t)  0
  ?:  =(0xc2 i.t)  2
  ?:  &(=(0xe2 i.t) (gte i.t.t 0x80) (lte i.t.t 0xaf))  3
  ?:  &(=(0xe3 i.t) =(0x80 i.t.t))  3
  ?:  &(=(0xf0 i.t) =(0x9f i.t.t))  4
  0
::  +stop-words: a small fixed set of high-frequency English function words
::  (3+ chars, since shorter ones are already dropped by the min-length filter)
::  excluded from the term index. Deliberately small + fixed so this lib stays
::  pure and unit-testable. Content words (man/new/old/…) are NOT here.
++  stop-words
  ^~  ^-  (set @t)
  %-  ~(gas in *(set @t))
  ^-  (list @t)
  :~  'the'  'and'  'for'  'are'  'but'  'not'  'you'  'all'  'any'
      'can'  'has'  'had'  'her'  'was'  'one'  'our'  'out'  'his'
      'how'  'now'  'see'  'two'  'way'  'who'  'did'  'its'  'let'
      'say'  'she'  'too'  'use'  'that'  'this'  'with'  'have'  'from'
      'they'  'will'  'would'  'there'  'their'  'what'  'which'  'when'
      'make'  'like'  'time'  'just'  'him'  'know'  'take'  'into'
      'your'  'good'  'some'  'could'  'them'  'than'  'then'  'were'
      'been'  'more'  'also'  'such'  'only'  'over'  'most'  'other'
      'these'  'about'  'where'  'after'  'before'  'between'  'because'
  ==
--
