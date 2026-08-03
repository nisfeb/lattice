::  Property tests for /lib/catalog-analyzer (gemtext -> catalog row data).
::
::  The body this lib folds over is fetched from ANOTHER SHIP. Its output is
::  then spliced into urQL and poked at obelisk, so two separate things have to
::  hold for arbitrary bytes: the analyzer must not crash, and its output must
::  stay inside the bounds the crawler sizes its pokes against. The lib's own
::  header explains why the caps exist ("a megabyte of `# x\n` would otherwise
::  yield one INSERT per line"); this file checks they are actually enforced on
::  input nobody chose.
::
::  Properties:
::    A1  +analyze is TOTAL and DETERMINISTIC
::    A2  every capped list is at or under its cap
::    A3  counts are consistent with the input (never exceed it)
::    A4  extracted structure is well formed (depth 1..3, positions in range
::        and strictly increasing)
::    A5  +urq-esc output cannot break out of a urQL string literal
::
::  A5 is the security-relevant one: it is the single arm every untrusted @t in
::  the catalog pipeline routes through before landing in a poke.
::
::  Run: mcp/run-tests {desk:grubbery, path:/tests/lib/catalog-analyzer-prop}
::
/+  *test, quiz=lattice-quiz, fz=lattice-fuzz, ca=catalog-analyzer
|%
++  chk  ~(check quiz `@uv`0x9e47.a1c3 96)
::
::  +gen-gem: token soup from the gemtext pool.
++  gen-gem
  |=  [size=@ud rng=_og]
  ^-  @t
  (brew:fz gem-pool:fz size rng)
::
::  ── A1: totality and determinism ────────────────────────────────────────────
::
++  test-prop-analyze-total
  =/  fate=vase
    !>
    |=  body=@t
    ^-  ?
    =/  a=analysis:ca  (analyze:ca body)
    (gte (met 3 title.a) 0)
  (expect !>((chk fate `gen-gem `cord-alts:fz)))
::
::  Purity. The lib's header claims it "runs identically in /tests and in the
::  live crawler", which is only true if it is a function of its argument.
::  Analyzing twice must give the same noun, including the term ranking, whose
::  tie-break exists precisely so the top-N cap is stable across crawls.
++  test-prop-analyze-deterministic
  =/  fate=vase
    !>
    |=  body=@t
    ^-  ?
    =((analyze:ca body) (analyze:ca body))
  (expect !>((chk fate `gen-gem `cord-alts:fz)))
::
::  The hash names the body and nothing else. If it ever drifted from +sham
::  over the raw cord, two different bodies could share a row identity.
++  test-prop-hash-is-body
  =/  fate=vase
    !>
    |=  body=@t
    ^-  ?
    =((sham body) hash:(analyze:ca body))
  (expect !>((chk fate `gen-gem `cord-alts:fz)))
::
::  ── A2: the fan-out caps are enforced ───────────────────────────────────────
::
::  One page must never turn into an unbounded number of catalog rows. These
::  are the caps the lib declares; a page that beat any of them would amplify
::  into a poke sized by the ATTACKER rather than by this code.
++  test-prop-caps-hold
  =/  fate=vase
    !>
    |=  body=@t
    ^-  ?
    =/  a=analysis:ca  (analyze:ca body)
    ?&  (lte (lent headings.a) heading-max:ca)
        (lte (lent links.a) link-max:ca)
        (lte (lent tags.a) tag-max:ca)
        (lte (lent terms.a) term-max:ca)
        (lte (met 3 author-category.a) term-len-max:ca)
        (lte (met 3 summary.a) summary-max:ca)
    ==
  (expect !>((chk fate `gen-gem `cord-alts:fz)))
::
::  And no single stored value is unbounded either. A page with one giant
::  space-free run must not put a multi-KB "term" in the index.
++  test-prop-term-length-bounded
  =/  fate=vase
    !>
    |=  body=@t
    ^-  ?
    =/  a=analysis:ca  (analyze:ca body)
    %+  levy  terms.a
    |=  t=term:ca
    ^-  ?
    ?&  (lte (met 3 term.t) term-len-max:ca)
        (gte (met 3 term.t) 3)
        (gth tf.t 0)
    ==
  (expect !>((chk fate `gen-gem `cord-alts:fz)))
::
::  ── A3: counts cannot exceed the input that produced them ───────────────────
::
::  Words are whitespace-separated tokens of the body, so there cannot be more
::  of them than there are bytes. Same for lines. These are the arithmetic
::  sanity checks that catch an accumulator being added to twice, which is
::  exactly the shape of bug a single-pass fold with six accumulators invites.
++  test-prop-counts-bounded-by-input
  =/  fate=vase
    !>
    |=  body=@t
    ^-  ?
    =/  a=analysis:ca  (analyze:ca body)
    =/  n=@ud  (met 3 body)
    ?&  (lte word-count.a (add 1 n))
        (lte body-lines.a (add 1 n))
    ==
  (expect !>((chk fate `gen-gem `cord-alts:fz)))
::
::  ── A4: extracted structure is well formed ──────────────────────────────────
::
::  Depth is capped at 3 by the prefix ladder (`#### ` is not a level-4
::  heading, it is a level-3 heading whose text starts with '#'), and every
::  position is a real line index. Positions must also strictly increase:
::  they are assigned from a counter that advances once per line, and the lists
::  are built reversed and flopped, so a duplicate or an inversion means a
::  branch forgot to advance `pos` or the flop went missing.
++  test-prop-heading-structure
  =/  fate=vase
    !>
    |=  body=@t
    ^-  ?
    =/  a=analysis:ca  (analyze:ca body)
    =/  well=?
      %+  levy  headings.a
      |=  h=heading:ca
      ^-  ?
      ?&((gte depth.h 1) (lte depth.h 3) (lth position.h body-lines.a))
    =/  hp=(list @ud)  (turn headings.a |=(h=heading:ca position.h))
    =/  lp=(list @ud)  (turn links.a |=(l=link:ca position.l))
    ?&(well (ascending hp) (ascending lp))
  (expect !>((chk fate `gen-gem `cord-alts:fz)))
::
::  The title is either a heading's text or a body line, never invented. Where
::  a heading exists it must be the FIRST one, which is the rule the crawler
::  relies on to name a row.
++  test-prop-title-is-first-heading
  =/  fate=vase
    !>
    |=  body=@t
    ^-  $?(%drop ?)
    =/  a=analysis:ca  (analyze:ca body)
    ?~  headings.a  %drop
    =(title.a text.i.headings.a)
  (expect !>((chk fate `gen-gem `cord-alts:fz)))
::
::  ── A5: urQL literal safety ─────────────────────────────────────────────────
::
::  +urq-esc is the one arm standing between a remote ship's page body and an
::  obelisk poke. Its contract, from its own docstring: obelisk's lexer knows
::  exactly one escape (\' yields a quote) and takes every other byte verbatim,
::  there is NO \\ rule, and a raw control byte can cut a literal short. So the
::  output must satisfy all three of:
::
::    - no byte below 32          (a control byte can terminate the literal)
::    - every ' is preceded by \  (an unescaped quote closes the literal)
::    - every \ is followed by '  (a lone \ before the caller's closing quote
::                                 would eat it, and the literal never ends)
::
::  Anything else is urQL injection: the rest of a multi-statement poke gets
::  swallowed as string content, or worse, executes.
++  test-prop-urq-esc-cannot-escape
  =/  fate=vase
    !>
    |=  s=@t
    ^-  ?
    (urq-ok (urq-esc:ca (trip s)))
  (expect !>((chk fate `gen-gem `cord-alts:fz)))
::
::  +urq-esc is also not allowed to lose the payload wholesale; it is an
::  escaper, not a filter. Output is at most 2 bytes per input byte (the \'
::  pair is the worst case) and at least 1 (nothing is deleted).
++  test-prop-urq-esc-length
  =/  fate=vase
    !>
    |=  s=@t
    ^-  ?
    =/  n=@ud  (lent (trip s))
    =/  m=@ud  (lent (urq-esc:ca (trip s)))
    ?&((gte m n) (lte m (mul 2 n)))
  (expect !>((chk fate `gen-gem `cord-alts:fz)))
::
::  ── helpers ─────────────────────────────────────────────────────────────────
::
::  +ascending: strictly increasing?
++  ascending
  |=  l=(list @ud)
  ^-  ?
  ?~  l  &
  =/  prev=@ud  i.l
  =/  r=(list @ud)  t.l
  |-  ^-  ?
  ?~  r  &
  ?.  (gth i.r prev)  |
  $(r t.r, prev i.r)
::
::  +urq-ok: does this tape satisfy the three conditions above? Walked with a
::  one-byte lookbehind rather than a regex, because there is no regex and
::  because the condition really is that local.
++  urq-ok
  |=  t=tape
  ^-  ?
  =/  esc=?  |                        ::  the previous byte was a backslash
  |-  ^-  ?
  ?~  t  !esc                         ::  cannot END on a lone backslash
  =/  c=@tD  i.t
  ?:  (lth c 32)  |                   ::  raw control byte: cuts the literal
  ?:  esc  ?&(=(39 c) $(t t.t, esc |))
  ?:  =(39 c)  |                      ::  a quote with no backslash in front
  ?:  =(92 c)  $(t t.t, esc &)
  $(t t.t, esc |)
--
