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
::  a token is indexed whole and by its parts, so a word that touches
::  punctuation inside its token is still found: the text of a link, the
::  sides of a slash, a dash or an equals sign
++  test-index-parts
  =/  doc  (index-terms:li ~ "read the [kubernetes](https://kubernetes.io) docs")
  =/  long=tape  "see [Mercury](https://en.wikipedia.org/wiki/Mercury_(planet)?utm_source=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa) now"
  =/  mix  (index-terms:li ~ "client/server name=value foo,bar [[notes/todo]] ~ricsul-bilwyt foo.hoon state—of—the—art")
  =/  got  |=([m=(map @t @ud) ws=(list @t)] (skip ws |=(w=@t (~(has by m) w))))
  ;:  weld
    (expect-eq !>(`(list @t)`~) !>((got doc ~['read' 'kubernetes' 'https' 'docs' 'kubernetes](https://kubernetes.io'])))
    (expect-eq !>(2) !>((~(got by doc) 'kubernetes')))
    ::  a link too long to keep whole still gives its words
    (expect-eq !>(`(list @t)`~) !>((got (index-terms:li ~ long) ~['mercury' 'wikipedia' 'planet'])))
    %+  expect-eq  !>(`(list @t)`~)
    !>  %+  got  mix
        :~  'client'  'server'  'name'  'value'  'foo'  'bar'  'notes'  'todo'
            'ricsul'  'bilwyt'  'hoon'  'state'  'art'
            'client/server'  'ricsul-bilwyt'  'foo.hoon'  'notes/todo'
        ==
    ::  a plain word counts once per use, and short parts and stop words stay out
    =/  few  (index-terms:li ~ "word (word), a/b the/of")
    (expect-eq !>([`(unit @ud)``2 | | |]) !>([(~(get by few) 'word') (~(has by few) 'the') (~(has by few) 'of') (~(has by few) 'a')]))
  ==
--
