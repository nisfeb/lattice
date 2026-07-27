::  Unit tests for /lib/catalog-analyzer (pure gemtext extraction).  Run with:
::    -test %/tests/lib/catalog-analyzer ~   (or the run-tests MCP tool)
::
::  Faced import (ca=catalog-analyzer) so `analysis` and friends can't clash.
::
/+  *test, ca=catalog-analyzer
|%
::  +analyze title fallback: a heading-less page (here a single `=>` link line)
::  takes the first non-blank line as its title, not '' (was blank before the fix
::  hoisted first-non-blank out of the plain-body-only branch).
::
++  test-title-link-only
  =/  a  (analyze:ca '=> urb://x/a First link')
  (expect-eq !>(`@t`'=> urb://x/a First link') !>(title.a))
::  a heading still WINS over the first-non-blank fallback.
::
++  test-title-heading-wins
  =/  a  (analyze:ca '# Real Title')
  (expect-eq !>(`@t`'Real Title') !>(title.a))
::  a trailing CR (the CRLF terminator to-wain leaves on the line) is stripped, so
::  the tag is `news`, not `news\r` (which urq-esc would store as 'news ' and break
::  exact-match tag lookups).
::
++  test-tag-crlf-stripped
  =/  a  (analyze:ca `@t`(cat 3 '#news' 13))
  (expect-eq !>(`(list @t)`~['news']) !>(tags.a))
::
::  ── +urq-esc: obelisk string-literal escaping ──
::  obelisk's cord-literal lexer has exactly ONE escape rule (\' -> literal
::  quote) and NO \\ rule, so backslashes must be spaced out, never doubled:
::  a doubled trailing backslash would emit 'evil\\' whose last \ pairs with
::  the caller's CLOSING quote under the \' rule, unterminating the literal
::  and swallowing the rest of the multi-statement poke (urQL injection).
::
::  a clean string passes through untouched.
++  test-urq-esc-plain
  (expect-eq !>("hello") !>((urq-esc:ca "hello")))
::  ' is escaped to \' — the one escape obelisk understands.
++  test-urq-esc-quote
  (expect-eq !>(`tape`['i' 'n' '\\' '\'' 't' ~]) !>((urq-esc:ca "in't")))
::  control bytes — newline (10), CR (13), tab (9) — become spaces.
++  test-urq-esc-strips-control
  ;:  weld
    (expect-eq !>(`tape`['a' ' ' 'b' ~]) !>((urq-esc:ca `tape`['a' `@tD`10 'b' ~])))
    (expect-eq !>(`tape`['a' ' ' 'b' ~]) !>((urq-esc:ca `tape`['a' `@tD`13 'b' ~])))
    (expect-eq !>(`tape`['x' ' ' 'y' ~]) !>((urq-esc:ca `tape`['x' `@tD`9 'y' ~])))
  ==
::  backslashes become spaces, NEVER doubled (obelisk has no \\ un-escape).
++  test-urq-esc-backslash
  ;:  weld
    ::  trailing backslash — the injection case (a hostile page's tag `evil\`)
    (expect-eq !>(`tape`['e' 'v' 'i' 'l' ' ' ~]) !>((urq-esc:ca "evil\\")))
    ::  backslash-then-quote: \ -> space, ' still escaped to \'
    (expect-eq !>(`tape`['a' ' ' '\\' '\'' 'b' ~]) !>((urq-esc:ca "a\\'b")))
    ::  interior backslash
    (expect-eq !>(`tape`['a' ' ' 'b' ~]) !>((urq-esc:ca "a\\b")))
    ::  a run of backslashes: one space each, no pairing survives
    (expect-eq !>(`tape`['x' ' ' ' ' 'y' ~]) !>((urq-esc:ca "x\\\\y")))
  ==
::  ── +normalize-term: the search-index tokenizer's normalizer ──
::  The server re-normalizes query terms through this same gate
::  (/catalog-search), so client and index can never drift.
::
++  test-normalize-term-case-and-trim
  ;:  weld
    ::  lower-cased
    (expect-eq !>(`(unit @t)``'rust') !>((normalize-term:ca "Rust")))
    ::  edge punctuation trimmed from both ends
    (expect-eq !>(`(unit @t)``'hello') !>((normalize-term:ca "(hello)!")))
    ::  interior punctuation survives (C-3PO stays one term)
    (expect-eq !>(`(unit @t)``'c-3po') !>((normalize-term:ca "C-3PO")))
  ==
::
++  test-normalize-term-drops
  ;:  weld
    ::  under 3 chars after trimming
    (expect-eq !>(`(unit @t)`~) !>((normalize-term:ca "ab")))
    (expect-eq !>(`(unit @t)`~) !>((normalize-term:ca "C++")))
    ::  stop words
    (expect-eq !>(`(unit @t)`~) !>((normalize-term:ca "the")))
    (expect-eq !>(`(unit @t)`~) !>((normalize-term:ca "and")))
    ::  adversarial giant token (over term-len-max = 64)
    (expect-eq !>(`(unit @t)`~) !>((normalize-term:ca (reap 70 'a'))))
  ==
--
