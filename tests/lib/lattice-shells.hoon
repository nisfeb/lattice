::  Unit tests for /lib/lattice-shells, the compiled content shells.
::  Run with:  -test /=grubbery=/tests/lib/lattice-shells ~
::
::  The evaluator used to ream and slap a content page's shell every run.
::  The lib compiles one per builder when it is built. What the cached
::  gate answers must be exactly what the compile it replaced answers, for
::  every builder, so each body below runs through both.
::
/+  *test, pg=lattice-pg, csh=lattice-shells
|%
::  the builders a content page may be written in
++  builders
  ^-  (list @tas)
  ~[%md %gmi %html %text %js %css %tex %fodt %fods %geojson %scad]
::  bodies that tell the builders apart, and ones that stress the cord
++  corpus
  ^-  (list @t)
  :~  ''
      'plain words'
      '# Title\0a\0a*em* and **strong**, `code`, [a link](/x) \\ and \27 q'
      '=> /page link\0a# gemtext heading\0a* item'
      '<b>bold</b> <script>1</script> &amp;'
      '\\section{a} $x^2$ \\textbf{b}'
      '{"type":"FeatureCollection","features":[]}'
      'cube([1,2,3]); // scad'
      '<office:document xmlns:office="x"><office:body/></office:document>'
      'tab\09line\0anewline\0a\0a  indented'
  ==
::  what the evaluator does with a shell: slam it with the body, then
::  slam the page gate that comes back with a run's environment, and
::  read the answer as a +result
++  run
  |=  [shell=vase body=@t]
  ^-  result:pg
  =/  page=vase  (slam shell !>(body))
  =/  env=vase
    !>([`(unit @t)`[~ 'cmd'] `(unit *)`[~ 7] `@da`~2026.1.1 `(list [path *])`~])
  ;;(result:pg q:(slam page env))
::  every builder, every body: the cached gate answers what a compile does.
::  The compile is the one the evaluator used to make, once per builder.
++  test-cached-equals-fresh
  =/  bs=(list @tas)  builders
  |-  ^-  tang
  ?~  bs  ~
  =/  fresh=vase  (slap !>(pg) (ream (content-shell:csh i.bs)))
  =/  bodies=(list @t)  corpus
  |-  ^-  tang
  ?~  bodies  ^$(bs t.bs)
  %+  weld
    %+  expect-eq
      !>((run fresh i.bodies))
    !>((run (shell-of:csh i.bs) i.bodies))
  $(bodies t.bodies)
::  the builders the lib compiles are the ones a page may be written in
++  test-builders
  %+  expect-eq  !>(`(set @tas)`(sy builders))  !>(content-builders:csh)
::  a page stored before this lib began must still match its shell: the
::  prefix is the bytes +wrap-content has always written
++  test-env-pre
  ;:  weld
    %+  expect-eq
      !>("|=  [cmd=(unit @t) dat=(unit *) now=@da deps=(list [path *])]  ^-  result  (")
      !>(content-env-pre:csh)
    %+  expect-eq  !>((crip content-env-pre:csh))  !>(content-env-pre-cord:csh)
    %+  expect-eq
      !>('|=  body=@t  |=  [cmd=(unit @t) dat=(unit *) now=@da deps=(list [path *])]  ^-  result  (md body)')
      !>((content-shell:csh %md))
  ==
--
