::  Property tests for /lib/lattice-urls (the urb:// codec).
::
::  /tests/lib/lattice-urls already asserts the two laws by EXAMPLE. That
::  catches a regression on the seven urls somebody thought of. This file
::  asserts them over generated input, which is the difference between "these
::  seven urls round-trip" and "round-tripping is a property of the codec".
::
::  Laws, as the lib's own docstring states them:
::    L1  de-urb(en-urb(node))  names the same referent
::    L2  en-urb(de-urb(url))   is a fixed point (idempotent normalization)
::    L3  de-urb never crashes, whatever bytes arrive
::
::  This lib parses urls that arrive from OTHER ships, so L3 is not hygiene.
::
::  Run: mcp/run-tests {desk:grubbery, path:/tests/lib/lattice-urls-prop}
::
/+  *test, quiz=lattice-quiz, fz=lattice-fuzz, lu=lattice-urls
|%
++  chk  ~(check quiz `@uv`0x5ea1.d0e5 96)
::
::  +re-en: a referent back to its url. %tree carries an absolute path, %pub a
::  vault-relative one, so re-encoding a %pub referent has to put the prefix
::  back on. This is the "en-urb" half of L2.
++  re-en
  |=  r=referent:lu
  ^-  @t
  ?:  ?=([%tree *] r)  (en-urb:lu ship.r pax.r)
  (en-urb:lu ship.r (weld pub-prefix:lu rel.r))
::
::  +gen-node: a [ship path] to encode. The path is drawn from the safe knots
::  and then, four times in five, planted under one of the code-versioned
::  mounts, so every canonical class (/p/, /k/, bare-pub, /n/, /t/) is hit
::  rather than only the raw-tree escape hatch.
++  gen-node
  |=  [size=@ud rng=_og]
  ^-  [@p path]
  =^  shp  rng  (pick-ship:fz rng)
  =^  many  rng  (rads:rng 5)
  =^  rel  rng  (gen-path:fz safe-knots:fz many rng)
  =^  which  rng  (rads:rng 5)
  =/  pax=path
    ?+  which  rel
      %0  (weld page-prefix:lu rel)
      %1  (weld know-prefix:lu rel)
      %2  (weld pub-prefix:lu rel)
      %3  (weld `path`/apps/'obelisk.obelisk_app' rel)
    ==
  [shp pax]
::
::  +gen-url: arbitrary url-shaped garbage. Well-formed urls appear by luck;
::  the point is everything else.
++  gen-url
  |=  [size=@ud rng=_og]
  ^-  @t
  (brew:fz url-pool:fz size rng)
::
::  ── L3: totality ────────────────────────────────────────────────────────────
::
::  +de-urb never crashes. It runs +stab on caller bytes; +stab bails on a knot
::  it cannot lex, which is why the lib wraps it in +mule. This asserts the
::  guard is actually in front of every path that reaches +stab, not just the
::  one that was tested by hand. Reaching the last line IS the property, so
::  `?~(r & &)` is a tautology on purpose.
++  test-prop-de-urb-total
  =/  fate=vase
    !>
    |=  raw=@t
    ^-  ?
    =/  r=(unit referent:lu)  (de-urb:lu raw)
    ?~(r & &)
  (expect !>((chk fate `gen-url `cord-alts:fz)))
::
::  +parse-urb-url is the older fetch-route parser and reaches +stab by a
::  different route. Same obligation.
++  test-prop-parse-urb-url-total
  =/  fate=vase
    !>
    |=  raw=@t
    ^-  ?
    =/  r=(unit [=ship =path])  (parse-urb-url:lu raw)
    ?~(r & &)
  (expect !>((chk fate `gen-url `cord-alts:fz)))
::
::  ── L1: en-urb then de-urb names the same referent ──────────────────────────
::
::  For a node NOT under the pub vault the referent is [%tree ship pax] with
::  the path unchanged. For one under the vault it is [%pub ship rel], because
::  published pages canonicalize to the pretty bare form. The single documented
::  exception is the vault root: en-urb sends both `~` and `/index` to the bare
::  `urb://~ship`, so an empty rel comes back as /index. That collapse is
::  asserted by name in the example tests, so it is dropped here rather than
::  silently tolerated.
++  test-prop-node-roundtrip
  =/  fate=vase
    !>
    |=  [shp=@p pax=path]
    ^-  $?(%drop ?)
    =/  mn=(unit path)  (strip-prefix:lu pub-prefix:lu pax)
    =/  d=(unit referent:lu)  (de-urb:lu (en-urb:lu shp pax))
    ?~  mn
      =(d `[%tree shp pax])
    ?:  ?=(~ u.mn)  %drop
    =(d `[%pub shp u.mn])
  (expect !>((chk fate `gen-node `no-alts:fz)))
::
::  ── L2: canonicalization is a fixed point ───────────────────────────────────
::
::  Encoding a node, decoding it, and encoding the result must land on the same
::  text. If L2 ever fails, two urls name one node and every index that keys on
::  the canonical form carries two rows for it.
++  test-prop-canon-fixed-point
  =/  fate=vase
    !>
    |=  [shp=@p pax=path]
    ^-  ?
    =/  u=@t  (en-urb:lu shp pax)
    =/  d=(unit referent:lu)  (de-urb:lu u)
    ?~  d  |
    =(u (re-en u.d))
  (expect !>((chk fate `gen-node `no-alts:fz)))
::
::  And the same from the other end: a url that decodes at all must re-encode
::  to something that decodes to the SAME referent. Generated garbage mostly
::  fails to decode and is dropped; what survives has to be stable.
++  test-prop-decode-encode-stable
  =/  fate=vase
    !>
    |=  raw=@t
    ^-  $?(%drop ?)
    =/  d=(unit referent:lu)  (de-urb:lu raw)
    ?~  d  %drop
    =/  again=(unit referent:lu)  (de-urb:lu (re-en u.d))
    =(d again)
  (expect !>((chk fate `gen-url `cord-alts:fz)))
::
::  ── invariants that hold for every encoding ─────────────────────────────────
::
::  +en-urb is total and always produces a urb:// url naming the ship it was
::  given. A path that cannot be expressed must still come back as SOMETHING
::  addressable, never as a crash and never as a url pointing elsewhere.
++  test-prop-en-urb-shape
  =/  fate=vase
    !>
    |=  [shp=@p pax=path]
    ^-  ?
    =/  s=tape  (trip (en-urb:lu shp pax))
    =/  who=tape  (scow %p shp)
    ?&  =("urb://" (scag 6 s))
        =(who (scag (lent who) `tape`(slag 6 s)))
    ==
  (expect !>((chk fate `gen-node `no-alts:fz)))
::
::  ── FINDING: the round-trip law is not total over `path` ────────────────────
::
::  `path` is (list @ta), and @ta is an AURA, not a validated type. Nothing
::  stops a knot holding a byte that @ta's SYNTAX does not admit: an uppercase
::  letter, a space. +en-urb renders such a knot with +spud, which does no
::  checking, and +de-urb reads it back with +stab, which lexes and fails. So
::  +en-urb can emit a url that +de-urb rejects, and L1 breaks.
::
::  Not hypothetical for a tree explorer: the path comes from clay, so anything
::  that ever writes a node under a mixed-case or space-bearing name produces a
::  urb:// url no ship (including the one that minted it) can resolve. It fails
::  CLOSED (a ~, not a crash), so the symptom is a dead link rather than a
::  vulnerability, but a dead link the codec itself minted.
::
::  Pinned rather than left as a red property: the assertion below states the
::  CURRENT behaviour. If +en-urb is ever taught to reject or escape unlexable
::  knots, this test goes red and whoever changed it reads this comment.
++  test-known-en-urb-emits-unparseable-urls
  =/  bad=(list path)
    :~  ~['A']
        ~['a b']
        (weld page-prefix:lu `path`~['Foo'])
    ==
  %+  roll  bad
  |=  [pax=path acc=tang]
  %+  weld  acc
  %+  expect-eq
    !>  `(unit referent:lu)`~
    !>  (de-urb:lu (en-urb:lu ~zod pax))
::
::  The generated counterpart. Over WILD knots the round-trip law must fail at
::  least sometimes; a run where it never fails would mean the generator stopped
::  generating and the test above is guarding nothing. %quiz has no "must be
::  refuted" mode, so this is stated as: the law does not hold over wild knots.
++  test-known-wild-knot-roundtrip-fails
  =/  give
    |=  [size=@ud rng=_og]
    ^-  [@p path]
    =^  shp  rng  (pick-ship:fz rng)
    =^  many  rng  (rads:rng 4)
    =^  rel  rng  (gen-path:fz wild-knots:fz +(many) rng)
    [shp (weld page-prefix:lu rel)]
  =/  fate=vase
    !>
    |=  [shp=@p pax=path]
    ^-  ?
    =(`[%tree shp pax] (de-urb:lu (en-urb:lu shp pax)))
  (expect-eq !>(|) !>((chk fate `give `no-alts:fz)))
--
