::  Pure helpers for the lattice nexus's private knowledge vault (know grubs).
::
::  Deliberately depends on base + clay types ONLY (path, @ta, @da, sets,
::  maps), no grubbery tarball/nexus types, so the SAME file compiles both
::  in a plain desk /lib (where these arms are unit-tested) and in grubbery's
::  gub/lib (where the lattice nexus wraps them). The nexus casts our structural
::  [pax nom] to a real rail:tarball.
::
|%
::  ==  Knowledge types, the canonical know-* shapes the nexus stores and the
::  HTTP reads emit.
::
+$  know-vector  [model=@t dim=@ud vec=(list @rd)]
+$  know-entry
  $:  body=@t
      updated=@da
      tags=(set @t)
      vector=(unit know-vector)
  ==
::  programmatic knowledge actions (poked at the vault-manager fiber).
::
+$  know-action
  $%  [%save key=@t body=@t]
      [%del key=@t]
      [%restore key=@t]
      [%move from=@t to=@t]
      [%tag key=@t tag=@t]
      [%untag key=@t tag=@t]
  ::  verbatim imports (used by the bulk-import endpoint, POST /know-import).
  ::  Unlike %save, these write the entry VERBATIM, preserving its original
  ::  updated/tags/vector, instead of stamping updated=now. %import lands a
  ::  live entry. %import-trashed lands it then soft-deletes (so it sits in
  ::  trash, body recoverable).
      [%import key=@t entry=know-entry]
      [%import-trashed key=@t entry=know-entry]
  ==
::  derived per-entry index row for the trash listing (know-trash). Lists
::  soft-deleted entries without reading bodies. bytes = body byte-length. restore is a RESERVED
::  slot for a future revision-restore feature (peek-at the firm cass captured at
::  delete time). The current soft-delete keeps the body grub live in the trash
::  vault and restores it whole, so restore is always ~. Kept in the row shape so
::  adding the feature later doesn't re-key the persisted know-index grub.
::
+$  index-entry  [updated=@da bytes=@ud tags=(set @t) restore=(unit @ud)]
+$  know-index   (map path index-entry)
::  +to-index-entry: project a stored entry onto its index row (restore always ~).
::
++  to-index-entry
  |=  e=know-entry
  ^-  index-entry
  [updated.e (met 3 body.e) tags.e ~]
::  +merge-save: body for %save. Preserves an existing entry's tags+vector
::  (save edits content only). A brand-new key starts untagged, no vector.
::
++  merge-save
  |=  [old=(unit know-entry) body=@t now=@da]
  ^-  know-entry
  ?~  old  [body now ~ ~]
  u.old(body body, updated now)
::  +add-tag / +del-tag: %tag / %untag. They touch only the tag set.
::
++  add-tag
  |=  [e=know-entry tag=@t]
  ^-  know-entry
  e(tags (~(put in tags.e) tag))
++  del-tag
  |=  [e=know-entry tag=@t]
  ^-  know-entry
  e(tags (~(del in tags.e) tag))
::  +vrail: a rail, expressed structurally so this lib stays grubbery-free.
::  Identical shape to rail:tarball ([p=path name=@ta]).
::
+$  vrail  [pax=path nom=@ta]
::  +entry-leaf: the fixed file name under each key-directory that holds a
::  vault entry's content. Reserving one leaf name per key-dir is what lets a
::  flat (map path know-entry), where /a and /a/b may BOTH be entries, map
::  onto a tree: /a becomes the file [/a %entry] and /a/b the file [/a/b
::  %entry], and the directory /a happily holds both the file `entry` and the
::  child directory `b`.
::
++  entry-leaf  `@ta`%entry
::  +key-to-rail: a know-key (path) -> the vault rail holding its entry,
::  rooted at [base]. Total: every key, including the empty key, maps.
::
++  key-to-rail
  |=  [base=path key=path]
  ^-  vrail
  [(weld base key) entry-leaf]
::  +rail-to-key: inverse of +key-to-rail. ~ if [vrail] is not an entry leaf
::  under [base] (wrong leaf name, or outside the vault subtree).
::
++  rail-to-key
  |=  [base=path =vrail]
  ^-  (unit path)
  ?.  =(nom.vrail entry-leaf)  ~
  =/  bl=@ud  (lent base)
  ?.  =(base (scag bl pax.vrail))  ~
  `(slag bl pax.vrail)
::  ==  Recall: ranked search, snippets, duplicates, front matter, links.
::
::  Pure and shared. grubbery's MCP tools carry a copy of this file, so a
::  search ranks the same through the tools, the /know-search route and the
::  eval (scripts/know-eval.mjs). Measured on the live store, 455 entries and
::  a private 42-question set, October 2026: whole-string substring search put
::  an expected entry in the top five for 0 questions, this BM25 for 40.
::
::  +stop-words: too common to rank on.
++  stop-words
  ^~
  %-  silt
  ^-  (list @t)
  :~  'the'  'and'  'or'  'of'  'to'  'in'  'on'  'for'  'is'  'it'  'be'
      'as'  'at'  'by'  'with'  'that'  'this'  'from'  'are'  'was'  'not'
      'but'  'if'  'so'  'we'  'you'  'my'  'our'  'me'  'do'  'does'  'can'
      'may'  'should'  'how'  'what'  'which'  'who'  'when'  'where'  'why'
      'there'  'their'  'they'  'them'  'its'  'into'  'than'  'then'  'also'
      'just'  'any'  'all'  'about'  'after'  'before'  'over'  'under'  'out'
      'up'  'off'  'an'
  ==
::  +seam: where a word splits into parts. ~ricsul-bilwyt is one word, and
::  also ricsul and bilwyt.
++  seam
  |=  c=@tD
  ^-  ?
  ?|(=(c '~') =(c '-') =(c '.') =(c '_') =(c '/'))
++  word-char
  |=  c=@tD
  ^-  ?
  ?|(&((gte c 'a') (lte c 'z')) &((gte c '0') (lte c '9')) (seam c))
::  +terms: a text's ranking terms, in order, repeats kept. Lower-cased
::  words with their parts, words under two letters and stop words dropped,
::  then stemmed.
++  terms
  |=  t=@t
  ^-  (list @t)
  %-  zing
  %+  turn  (runs (cass (trip t)))
  |=  w=tape
  ^-  (list @t)
  =/  s=tape  (trim-seams w)
  =/  ps=(list tape)
    ?.  (lien s seam)  ~[s]
    [s (skip (split-seams s) |=(p=tape =(~ p)))]
  %+  murn  ps
  |=  p=tape
  ^-  (unit @t)
  ?:  (lth (lent p) 2)  ~
  ?:  (~(has in stop-words) (crip p))  ~
  `(crip (stem p))
::  +runs: maximal runs of word characters.
++  runs
  |=  t=tape
  ^-  (list tape)
  =|  [cur=tape out=(list tape)]
  |-  ^-  (list tape)
  ?~  t  (flop ?~(cur out [(flop cur) out]))
  ?:  (word-char i.t)  $(t t.t, cur [i.t cur])
  $(t t.t, cur ~, out ?~(cur out [(flop cur) out]))
++  drop-seams
  |=  w=tape
  ^-  tape
  ?~  w  ~
  ?.  (seam i.w)  w
  $(w t.w)
++  trim-seams  |=(w=tape ^-(tape (flop (drop-seams (flop (drop-seams w))))))
++  split-seams
  |=  w=tape
  ^-  (list tape)
  =|  [cur=tape out=(list tape)]
  |-  ^-  (list tape)
  ?~  w  (flop [(flop cur) out])
  ?:  (seam i.w)  $(w t.w, cur ~, out [(flop cur) out])
  $(w t.w, cur [i.w cur])
::  +stem: plurals and the commonest suffixes off, so releases, released and
::  releasing meet release. Cheaper than Porter, and on the eval it was the
::  difference between 38 and 40.
++  stem
  |=  w=tape
  ^-  tape
  =/  n=@ud  (lent w)
  ?:  (lth n 5)  w
  =/  ends  |=(x=tape =(x (slag (sub n (lent x)) w)))
  ?:  (ends "ies")  (weld (scag (sub n 3) w) "y")
  ?:  (ends "sses")  (scag (sub n 2) w)
  ?:  &((ends "ing") (gth n 6))  (scag (sub n 3) w)
  ?:  &((ends "ed") (gth n 5))  (scag (sub n 2) w)
  ?:  &((ends "s") !(ends "ss") !(ends "us"))  (scag (dec n) w)
  w
::  +front: an entry body's front matter (`name: value` lines between two
::  `---` lines at the very top) and the text after it. The tools keep
::  provenance there (author, source, created, verified, superseded-by), so
::  it travels with the entry through moves, trash, history, import and
::  export, and an older reader just sees text.
++  front
  |=  body=@t
  ^-  [meta=(list [k=@t v=@t]) rest=@t]
  =/  t=tape  (trip body)
  ?.  =("---\0a" (scag 4 t))  [~ body]
  =/  aft=tape  (slag 4 t)
  =/  e=(unit @ud)  (find "\0a---" aft)
  ?~  e  [~ body]
  =/  tail=tape  (slag (add u.e 4) aft)
  =?  tail  &(?=(^ tail) =(10 i.tail))  t.tail
  :_  (crip tail)
  %+  murn  (to-wain:format (crip (scag u.e aft)))
  |=  l=@t
  ^-  (unit [k=@t v=@t])
  =/  lt=tape  (trip l)
  =/  c=(unit @ud)  (find ":" lt)
  ?~  c  ~
  `[(crip (trim-sp (scag u.c lt))) (crip (trim-sp (slag +(u.c) lt)))]
++  drop-sp
  |=  t=tape
  ^-  tape
  ?~  t  ~
  ?.  =(' ' i.t)  t
  $(t t.t)
++  trim-sp  |=(t=tape ^-(tape (flop (drop-sp (flop (drop-sp t))))))
++  meta-get
  |=  [meta=(list [k=@t v=@t]) k=@t]
  ^-  (unit @t)
  =/  hit  (skim meta |=([a=@t *] =(a k)))
  ?~(hit ~ `v.i.hit)
::  +meta-put: set one field, in place if present. '' removes it.
++  meta-put
  |=  [meta=(list [k=@t v=@t]) k=@t v=@t]
  ^-  (list [k=@t v=@t])
  =/  kept  (skip meta |=([a=@t *] =(a k)))
  ?:  =('' v)  kept
  ?.  (lien meta |=([a=@t *] =(a k)))  (snoc meta [k v])
  (turn meta |=([a=@t b=@t] ?:(=(a k) [a v] [a b])))
++  with-front
  |=  [meta=(list [k=@t v=@t]) rest=@t]
  ^-  @t
  ?~  meta  rest
  =/  lines=tape
    (zing (turn meta |=([a=@t b=@t] :(weld (trip a) ": " (trip b) "\0a"))))
  =/  body=tape  (trip rest)
  (crip :(weld "---\0a" lines "---\0a" body))
::  +iso-day / +from-iso-day: front matter dates, 2026-10-03.
++  iso-day
  |=  d=@da
  ^-  @t
  =/  dt  (yore d)
  =/  pad  |=(n=@ud ^-(tape ?:((lth n 10) ['0' (a-co:co n)] (a-co:co n))))
  =/  yr=tape  (a-co:co y.dt)
  =/  mo=tape  (pad m.dt)
  =/  dy=tape  (pad d.t.dt)
  (crip :(weld yr "-" mo "-" dy))
++  from-iso-day
  |=  v=@t
  ^-  (unit @da)
  =/  p  (rush v ;~((glue hep) dem dem dem))
  ?~  p  ~
  =/  [y=@ud m=@ud d=@ud]  u.p
  ?.  &((gte m 1) (lte m 12) (gte d 1) (lte d 31) (gth y 0))  ~
  `(year [[& y] m [d 0 0 0 ~]])
::  +key-of: a wikilink or argument as a key. [[user/x]] and [[/user/x]]
::  both name /user/x.
++  key-of
  |=  k=@t
  ^-  (unit path)
  =/  t=tape  (trip k)
  =/  full=tape  ?:(?=([%'/' *] t) t ['/' t])
  =/  res  (mule |.((stab (crip full))))
  ?:(?=(%& -.res) ?~(p.res ~ `p.res) ~)
::  +links: the keys a body links to with [[x]] or [[x|label]], in order,
::  once each.
++  links
  |=  body=@t
  ^-  (list path)
  =/  t=tape  (trip body)
  =|  out=(list path)
  |-  ^-  (list path)
  =/  i=(unit @ud)  (find "[[" t)
  ?~  i  (flop out)
  =/  aft=tape  (slag (add u.i 2) t)
  =/  j=(unit @ud)  (find "]]" aft)
  ?~  j  (flop out)
  =/  inner=tape  (scag u.j aft)
  =/  bar=(unit @ud)  (find "|" inner)
  =/  k=(unit path)  (key-of (crip (trim-sp ?~(bar inner (scag u.bar inner)))))
  =?  out  &(?=(^ k) !(lien out |=(p=path =(p u.k))))  [u.k out]
  $(t (slag (add u.j 2) aft))
::  +$  doc: an entry as ranking sees it. The key counts twice and each tag
::  once, over the body's terms; front matter is not ranked.
+$  doc  [key=path tf=(map @t @ud) len=@ud]
++  to-doc
  |=  [key=path e=know-entry]
  ^-  doc
  =/  tg=tape  (zing (turn ~(tap in tags.e) |=(g=@t (weld (trip g) " "))))
  =/  ts=(list [t=@t w=@ud])
    ;:  weld
      (turn (terms (spat key)) |=(t=@t [t 2]))
      (turn (terms (crip tg)) |=(t=@t [t 1]))
      (turn (terms rest:(front body.e)) |=(t=@t [t 1]))
    ==
  :+  key
    %+  roll  ts
    |=  [[t=@t w=@ud] m=(map @t @ud)]
    (~(put by m) t (add w (~(gut by m) t 0)))
  (roll (turn ts |=([* w=@ud] w)) add)
::  +$  term-cache: each entry's doc, as of its updated time and tags. Lattice
::  keeps it at /know/terms so a search reads one grub instead of tokenizing
::  the store (5.5 of 6.2 seconds per query on 455 entries). Every reader
::  checks a row against its entry (+docs-of), so a stale or missing row
::  costs speed, never a wrong answer.
+$  term-row  [updated=@da tags=(set @t) =doc]
+$  term-cache  (map path term-row)
++  row-of  |=([k=path e=know-entry] ^-(term-row [updated.e tags.e (to-doc k e)]))
++  fresh-row
  |=  [r=(unit term-row) e=know-entry]
  ^-  ?
  &(?=(^ r) =(updated.u.r updated.e) =(tags.u.r tags.e))
::  +docs-of: the docs for these entries, from the cache where it is current
++  docs-of
  |=  [es=(list [key=path e=know-entry]) tc=term-cache]
  ^-  (list doc)
  %+  turn  es
  |=  [k=path e=know-entry]
  =/  r=(unit term-row)  (~(get by tc) k)
  ?:  (fresh-row r e)  doc:(need r)
  (to-doc k e)
::  +refresh: the cache made current for the whole store, rows for deleted
::  entries dropped; chg says whether it differs from what was stored.
++  refresh
  |=  [es=(list [key=path e=know-entry]) tc=term-cache]
  ^-  [chg=? tc=term-cache]
  =/  out=term-cache
    %-  malt
    %+  turn  es
    |=  [k=path e=know-entry]
    ^-  [path term-row]
    =/  r=(unit term-row)  (~(get by tc) k)
    ?:  (fresh-row r e)  [k (need r)]
    [k (row-of k e)]
  [!=(out tc) out]
::  +lg2m: 1.000 x log2(a/b) for a > b > 0, else 0. Fixed point, since hoon
::  has no float log. IDF only orders, so log2 for ln changes no ranking.
++  lg2m
  |=  [a=@ud b=@ud]
  ^-  @ud
  ?:  |(=(0 b) (lte a b))  0
  =/  r=@ud  (div (lsh [0 20] a) b)
  =/  ip=@ud  (sub (met 0 r) 21)
  =/  y=@ud  (rsh [0 ip] r)
  =|  [i=@ud f=@ud]
  |-  ^-  @ud
  ?:  =(10 i)  (add (mul ip 1.000) (div (mul f 1.000) 1.024))
  =/  y2=@ud  (rsh [0 20] (mul y y))
  ?:  (gte y2 (bex 21))
    $(i +(i), y (rsh [0 1] y2), f +((mul 2 f)))
  $(i +(i), y y2, f (mul 2 f))
::  +rank: BM25 (k1 1.2, b 0.75) of each doc for the query, best first.
::  strength is the share (percent) of the query's IDF the doc carries: the
::  answer to "is any of this about my question". On the eval every
::  nothing-stored question but one scored under 35, every real one over.
+$  hit  [score=@ud strength=@ud key=path]
++  rank
  |=  [ds=(list doc) q=@t]
  ^-  (list hit)
  =/  qt=(list @t)  ~(tap in (silt (terms q)))
  =/  n=@ud  (lent ds)
  ?:  |(=(0 n) =(~ qt))  ~
  =/  total=@ud  (max 1 (roll (turn ds |=(d=doc len.d)) add))
  =/  idf=(map @t @ud)
    %-  ~(gas by *(map @t @ud))
    %+  turn  qt
    |=  t=@t
    =/  df=@ud  (lent (skim ds |=(d=doc (~(has by tf.d) t))))
    [t (lg2m (add (mul 2 n) 2) +((mul 2 df)))]
  =/  all=@ud  (max 1 (roll ~(val by idf) add))
  =/  out=(list hit)
    %+  murn  ds
    |=  d=doc
    ^-  (unit hit)
    =/  [s=@ud c=@ud]
      %+  roll  qt
      |=  [t=@t acc=[s=@ud c=@ud]]
      =/  f=@ud  (~(gut by tf.d) t 0)
      ?:  =(0 f)  acc
      =/  w=@ud  (~(got by idf) t)
      =/  den=@ud
        :(add (mul f 1.000) 300 (div (mul 900 (mul len.d n)) total))
      [(add s.acc (div (mul w (div (mul f 2.200.000) den)) 1.000)) (add c.acc w)]
    ?:  =(0 s)  ~
    `[s (div (mul 100 c) all) key.d]
  (sort out |=([a=hit b=hit] (gth score.a score.b)))
::  +snippet: the body line that carries the most query terms, clipped to
::  about 200 bytes around the first one.
++  snippet
  |=  [body=@t q=@t]
  ^-  @t
  =/  qs=(set @t)  (silt (terms q))
  =/  ls=(list @t)  (skip (to-wain:format rest:(front body)) |=(l=@t =('' l)))
  ?~  ls  ''
  =/  best=[n=@ud l=@t]
    %+  roll  `(list @t)`ls
    |=  [l=@t b=[n=@ud l=@t]]
    =/  n=@ud  ~(wyt in (~(int in qs) (silt (terms l))))
    ?:((gth n n.b) [n l] b)
  (clip-around ?:(=(0 n.best) i.ls l.best) qs)
++  clip-around
  |=  [l=@t qs=(set @t)]
  ^-  @t
  =/  t=tape  (trip l)
  ?:  (lte (lent t) 200)  l
  =/  low=tape  (cass t)
  =/  at=@ud
    %+  roll  ~(tap in qs)
    |=  [q=@t a=@ud]
    =/  i=(unit @ud)  (find (trip q) low)
    ?~  i  a
    ?:(|(=(0 a) (lth u.i a)) u.i a)
  =/  s=@ud  ?:((gth at 60) (sub at 60) 0)
  ::  never split a UTF-8 character: no continuation byte first, and a
  ::  trailing multi-byte character goes whole
  =/  cut=tape  (flop (drop-high (flop (drop-cont (scag 200 (slag s t))))))
  =/  pre=tape  ?:(=(0 s) "" "...")
  =/  suf=tape  ?:((lth (add s 200) (lent t)) "..." "")
  (crip :(weld pre cut suf))
::  +drop-cont: leading UTF-8 continuation bytes off.
++  drop-cont
  |=  t=tape
  ^-  tape
  ?~  t  ~
  ?.  &((gte i.t 128) (lth i.t 192))  t
  $(t t.t)
::  +drop-high: leading non-ASCII bytes off. Run on a reversed tape it drops
::  the last character if it is multi-byte, whole or cut.
++  drop-high
  |=  t=tape
  ^-  tape
  ?~  t  ~
  ?.  (gte i.t 128)  t
  $(t t.t)
::  +term-set / +overlap: the duplicate test. Percent of distinct terms two
::  bodies share. On the live store every true duplicate pair scored 60 or
::  more and every distinct pair under 45.
++  term-set  |=(body=@t ^-((set @t) (silt (terms rest:(front body)))))
++  overlap
  |=  [a=(set @t) b=(set @t)]
  ^-  @ud
  =/  u=@ud  ~(wyt in (~(uni in a) b))
  ?:  =(0 u)  0
  (div (mul 100 ~(wyt in (~(int in a) b))) u)
++  dup-at  ^-(@ud 60)
::  +near: the entries whose bodies share +similar-at or more of body's
::  terms, most shared first. The cache rules most entries out without
::  tokenizing them: an entry whose cached terms (key, tags and body)
::  share under 30 with body cannot share 40 by body alone, near enough.
++  near
  |=  [es=(list [key=path e=know-entry]) tc=term-cache body=@t]
  ^-  (list [o=@ud k=path])
  =/  mine=(set @t)  (term-set body)
  %+  sort
    %+  murn  es
    |=  [k=path e=know-entry]
    ^-  (unit [o=@ud k=path])
    =/  r=(unit term-row)  (~(get by tc) k)
    =/  rough=@ud  ?.((fresh-row r e) 100 (overlap mine ~(key by tf.doc:(need r))))
    ?.  (gte rough 30)  ~
    =/  o=@ud  (overlap mine (term-set body.e))
    ?.((gte o similar-at) ~ `[o k])
  |=([a=[o=@ud *] b=[o=@ud *]] (gth o.a o.b))
++  similar-at  ^-(@ud 40)
::  +weak-at: a best hit under this strength is reported as weak, the way to
::  say "probably nothing stored about this" without hiding what there is.
++  weak-at  ^-(@ud 35)
::  +superseded: where an entry says its fact now lives.
++  superseded
  |=  e=know-entry
  ^-  (unit @t)
  (meta-get meta:(front body.e) 'superseded-by')
::  +search: the query path the tools and the routes share. Words rank by
::  BM25; a query in double quotes must appear verbatim (key or body) and
::  ranks by its words. Superseded entries are left out unless old. tc is
::  the term cache, or ~ to tokenize everything.
++  search
  |=  [es=(list [key=path e=know-entry]) tc=term-cache q=@t old=?]
  ^-  (list hit)
  =/  qt=tape  (trip q)
  =/  phrase=(unit tape)
    ?.  ?=([%'"' * * *] qt)  ~
    ?.  =(`@`34 `@`(rear `tape`qt))  ~
    `(cass (snip `tape`t.qt))
  =/  live=(list [key=path e=know-entry])
    %+  skim  es
    |=  [key=path e=know-entry]
    ?&  |(old =(~ (superseded e)))
        ?~  phrase  &
        =/  hay=tape  (cass :(weld (trip (spat key)) " " (trip body.e)))
        ?=(^ (find u.phrase hay))
    ==
  (rank (docs-of live tc) ?~(phrase q (crip u.phrase)))
::  +hits-json: a search answer. weak marks a best hit under +weak-at.
++  hits-json
  |=  [es=(map path know-entry) hs=(list hit) q=@t k=@ud]
  ^-  json
  =/  best=@ud  ?~(hs 0 strength.i.hs)
  %-  pairs:enjs:format
  :~  ['query' s+q]
      ['count' (numb:enjs:format (lent hs))]
      ['strength' (numb:enjs:format best)]
      ['weak' b+(lth best weak-at)]
      :-  'results'
      :-  %a
      %+  turn  (scag k hs)
      |=  h=hit
      =/  e=know-entry  (~(got by es) key.h)
      =/  sup=(unit @t)  (superseded e)
      %-  pairs:enjs:format
      %+  weld
        ^-  (list [@t json])
        :~  ['key' s+(spat key.h)]
            ['score' (numb:enjs:format score.h)]
            ['strength' (numb:enjs:format strength.h)]
            ['updated' s+(scot %da updated.e)]
            ['tags' a+(turn ~(tap in tags.e) |=(t=@t s+t))]
            ['snippet' s+(snippet body.e q)]
        ==
      ^-  (list [@t json])
      ?~(sup ~ ~[['superseded_by' s+u.sup]])
  ==
::  ==  Lint: what a periodic tidy would fix, proposed, never applied here.
::
::  stale is an entry that names code (a file, an arm, a port, a commit) and
::  has not been verified, or edited, for +stale-days. Duplicates are found
::  without comparing every pair: each entry's eight rarest terms are its
::  signature, and only entries sharing three signature terms are compared.
::  On the live store that compared 38 pairs and found all 37 duplicates.
+$  lint
  $:  dups=(list [a=path b=path pct=@ud])
      broken=(list [from=path to=path])
      bad-super=(list [key=path to=@t])
      untagged=(list path)
      big=(list [key=path bytes=@ud])
      stale=(list [key=path days=@ud])
      orphans=(list path)
  ==
++  stale-days  ^-(@ud 30)
++  big-bytes  ^-(@ud 4.000)
++  names-code
  |=  body=@t
  ^-  ?
  =/  low=tape  (cass (trip body))
  %+  lien
    `(list tape)`~[".hoon" ".js" ".py" ".rs" ".ts" ".json" "++" "localhost:" "commit "]
  |=(n=tape ?=(^ (find n low)))
::  +checked: when an entry was last known true, its verified date or else
::  its last edit.
++  checked
  |=  e=know-entry
  ^-  @da
  (fall (biff (meta-get meta:(front body.e) 'verified') from-iso-day) updated.e)
++  lint-run
  |=  [es=(list [key=path e=know-entry]) now=@da]
  ^-  lint
  =/  keys=(set path)  (silt (turn es |=([k=path *] k)))
  =/  sets=(map path (set @t))
    (malt (turn es |=([k=path e=know-entry] [k (term-set body.e)])))
  ::  bound before use: a zing straight into +roll is a fuse-loop
  =/  every=(list @t)  (zing (turn ~(val by sets) |=(s=(set @t) ~(tap in s))))
  =/  df=(map @t @ud)
    %+  roll  every
    |=  [t=@t m=(map @t @ud)]
    (~(put by m) t +((~(gut by m) t 0)))
  =/  sig=(list [t=@t k=path])
    %-  zing
    %+  turn  ~(tap by sets)
    |=  [k=path s=(set @t)]
    =/  ts=(list @t)
      %+  scag  8
      %+  sort  ~(tap in s)
      |=  [a=@t b=@t]
      =/  da=@ud  (~(got by df) a)
      =/  db=@ud  (~(got by df) b)
      ?:(=(da db) (aor a b) (lth da db))
    (turn ts |=(t=@t [t k]))
  =/  inv=(map @t (list path))
    %+  roll  sig
    |=  [[t=@t k=path] m=(map @t (list path))]
    (~(put by m) t [k (~(gut by m) t ~)])
  ::  a term on more than 20 signatures is not rare, and would cost its
  ::  square in pairs
  =/  prs=(list [path path])
    %-  zing
    %+  turn  ~(val by inv)
    |=  ks=(list path)
    ?:  (gth (lent ks) 20)  ~
    =/  s=(list path)  (sort ks aor)
    |-  ^-  (list [path path])
    ?~  s  ~
    (weld (turn t.s |=(b=path [i.s b])) $(s t.s))
  =/  cnt=(map [path path] @ud)
    %+  roll  prs
    |=  [p=[path path] m=(map [path path] @ud)]
    (~(put by m) p +((~(gut by m) p 0)))
  =/  dups=(list [a=path b=path pct=@ud])
    %+  sort
      %+  murn  ~(tap by cnt)
      |=  [[a=path b=path] n=@ud]
      ^-  (unit [a=path b=path pct=@ud])
      ?.  (gte n 3)  ~
      =/  o=@ud  (overlap (~(got by sets) a) (~(got by sets) b))
      ?.((gte o dup-at) ~ `[a b o])
    |=([x=[a=path b=path pct=@ud] y=[a=path b=path pct=@ud]] (gth pct.x pct.y))
  =/  outs=(list [from=path to=path])
    %-  zing
    (turn es |=([k=path e=know-entry] (turn (links body.e) |=(t=path [k t]))))
  =/  ends=(list path)  (zing (turn outs |=([f=path t=path] ~[f t])))
  =/  linked=(set path)  (silt ends)
  :*  dups
      (skip outs |=([* t=path] (~(has in keys) t)))
    ::
      %+  murn  es
      |=  [k=path e=know-entry]
      ^-  (unit [key=path to=@t])
      =/  s=(unit @t)  (superseded e)
      ?~  s  ~
      =/  t=(unit path)  (key-of u.s)
      ?:(&(?=(^ t) (~(has in keys) u.t)) ~ `[k u.s])
    ::
      (murn es |=([k=path e=know-entry] ?.(=(~ tags.e) ~ `k)))
    ::
      %+  murn  es
      |=  [k=path e=know-entry]
      ^-  (unit [key=path bytes=@ud])
      =/  n=@ud  (met 3 body.e)
      ?.((gth n big-bytes) ~ `[k n])
    ::
      %+  murn  es
      |=  [k=path e=know-entry]
      ^-  (unit [key=path days=@ud])
      =/  c=@da  (checked e)
      =/  d=@ud  ?:((gth now c) (div (sub now c) ~d1) 0)
      ?.  &((gte d stale-days) (names-code body.e))  ~
      `[k d]
    ::
      (sort (skip ~(tap in keys) |=(k=path (~(has in linked) k))) aor)
  ==
++  lint-json
  |=  l=lint
  ^-  json
  =/  ks  |=(p=path s+(spat p))
  =/  num  numb:enjs:format
  %-  pairs:enjs:format
  :~  :-  'counts'
      %-  pairs:enjs:format
      :~  ['duplicates' (num (lent dups.l))]
          ['broken_links' (num (lent broken.l))]
          ['bad_supersede' (num (lent bad-super.l))]
          ['untagged' (num (lent untagged.l))]
          ['oversized' (num (lent big.l))]
          ['stale' (num (lent stale.l))]
          ['orphans' (num (lent orphans.l))]
      ==
      :-  'duplicates'
      a+(turn dups.l |=([a=path b=path p=@ud] (pairs:enjs:format ~[['a' (ks a)] ['b' (ks b)] ['overlap' (num p)]])))
      :-  'broken_links'
      a+(turn broken.l |=([f=path t=path] (pairs:enjs:format ~[['from' (ks f)] ['to' (ks t)]])))
      :-  'bad_supersede'
      a+(turn bad-super.l |=([k=path t=@t] (pairs:enjs:format ~[['key' (ks k)] ['to' s+t]])))
      ['untagged' a+(turn untagged.l ks)]
      :-  'oversized'
      a+(turn big.l |=([k=path n=@ud] (pairs:enjs:format ~[['key' (ks k)] ['bytes' (num n)]])))
      :-  'stale'
      a+(turn stale.l |=([k=path d=@ud] (pairs:enjs:format ~[['key' (ks k)] ['days' (num d)]])))
      ['orphans' a+(turn orphans.l ks)]
  ==
--
