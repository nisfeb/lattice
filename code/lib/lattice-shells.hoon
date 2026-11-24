::  /lib/lattice-shells, the content page shells, compiled once.
::
::  A content page (md, gmi, html, ...) never parses its body as hoon. Its
::  evaluator compiles a small shell for the page's builder and slams it
::  with the body. The shell text is the same for every page of a builder
::  and its subject is always the page stdlib (pg), so the compile is done
::  here, when the lib is built, and the kernel's build cache holds the
::  result. An evaluator takes a gate with +shell-of instead of a ream and
::  a slap of its own, which cost about 26 ms a page.
::
/<  pg  /lib/lattice-pg.hoon
::  the exact page-source shell EVERY content note is stored in. The
::  evaluator only knows hoon gates, so a note IS a gate returning
::  (BUILDER '...'). The app's +wrap-content writes prose into it and
::  +unwrap-content matches it, so the bytes here are the stored form.
::
=/  env-pre=tape
  "|=  [cmd=(unit @t) dat=(unit *) now=@da deps=(list [path *])]  ^-  result  ("
=/  env-cord=@t  (crip env-pre)
::  the builders a content page may be written in: pg constructors
::
=/  builders=(list @tas)
  ~[%md %gmi %html %text %js %css %tex %fodt %fods %geojson %scad]
::  the page gate of a content page with the body as its outer sample, so
::  the compile is a few lines whatever the size of the body
::
=/  shell-text
  |=  builder=@tas
  ^-  @t
  (crip :(weld "|=  body=@t  " env-pre (trip builder) " body)"))
::  one compile per builder, against the same subject the evaluator gives
::  a page's own code
::
=/  shells=(map @tas vase)
  %-  ~(gas by *(map @tas vase))
  %+  turn  builders
  |=  builder=@tas
  [builder (slap !>(pg) (ream (shell-text builder)))]
|%
++  content-env-pre  env-pre
++  content-env-pre-cord  env-cord
++  content-builders  ^-((set @tas) ~(key by shells))
++  content-shell  shell-text
::  +shell-of: the compiled shell gate of a builder. Crashes for a name
::  that is not a content builder: callers check +content-builders first.
::
++  shell-of
  |=  builder=@tas
  ^-  vase
  (~(got by shells) builder)
--
