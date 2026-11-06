::  Unit tests for /lib/lattice-index (the omnibar term index's tokenizer).
::
/+  *test, li=lattice-index
|%
::  +split-space splits on every whitespace byte, so the last word of a
::  line and the first of the next are two terms, not one glued token
++  test-split-space
  ;:  weld
    (expect-eq !>(`(list tape)`~["aa" "bb"]) !>((split-space:li "aa  bb ")))
    (expect-eq !>(`(list tape)`~["end" "next"]) !>((split-space:li "end\0anext")))
    (expect-eq !>(`(list tape)`~["one" "two" "six"]) !>((split-space:li "one\0d\0atwo\09six")))
    (expect-eq !>(`(list tape)`~) !>((split-space:li "\0a \0a")))
  ==
++  test-index-terms-lines
  %+  expect-eq  !>((~(gas by *(map @t @ud)) ~[['line' 1] ['next' 1] ['word' 2]]))
  !>((index-terms:li ~ "word line\0anext word"))
--
