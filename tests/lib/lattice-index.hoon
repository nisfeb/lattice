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
::  +query-terms: a query is tokenized as the index is, so a hyphenated
::  or dotted word is asked for whole, as +index-terms stored it
++  test-query-terms
  =/  doc  (index-terms:li ~ "met ~ricsul-bilwyt about foo.hoon")
  ;:  weld
    %+  expect-eq  !>(`(list @t)`~['ricsul-bilwyt' 'foo.hoon'])
    !>((query-terms:li "~RICSUL-BILWYT  foo.hoon, foo.hoon"))
    ::  every term a query asks for is one the indexer stored
    %+  expect-eq  !>(&)
    !>((levy (query-terms:li "ricsul-bilwyt foo.hoon") |=(t=@t (~(has by doc) t))))
    (expect-eq !>(`(list @t)`~) !>((query-terms:li "a of the")))
  ==
::  text past ASCII is indexed, and asked for, as written
++  test-index-non-ascii
  =/  doc  (index-terms:li ~ "日本語 Café über Привет “quoted” naïve—word")
  ;:  weld
    (expect !>((~(has by doc) '日本語')))
    (expect !>((~(has by doc) 'café')))
    (expect !>((~(has by doc) 'über')))
    (expect !>((~(has by doc) 'Привет')))
    (expect !>((~(has by doc) 'quoted')))
    (expect-eq !>(`(list @t)`~['日本語' 'café']) !>((query-terms:li "日本語, café")))
    (expect-eq !>(`(list @t)`~['quoted']) !>((query-terms:li "“quoted”")))
  ==
--
