::  Unit tests for /lib/lattice-pg (the page standard library).  Run with:
::    -test %/tests/lib/lattice-pg ~   (or the run-tests MCP tool)
::
::  Faced import (pg=lattice-pg) so `result`/`entry` can't clash.
::
/+  *test, pg=lattice-pg
|%
::  +esc is the XSS guard for html pages: every metacharacter neutralized,
::  ordinary text untouched.
::
++  test-esc
  ;:  weld
    (expect-eq !>('plain text') !>((esc:pg 'plain text')))
    (expect-eq !>('&lt;b&gt;') !>((esc:pg '<b>')))
    (expect-eq !>('&amp;&quot;') !>((esc:pg '&"')))
    %+  expect-eq
      !>  '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'
      !>  (esc:pg '<script>alert("x")</script>')
  ==
::  Constructors: the render mode and data land where the evaluator reads them.
::
++  test-constructors
  ;:  weld
    (expect-eq !>(`result:pg`[`'hi' ~ %text ~ ~]) !>((text:pg 'hi')))
    (expect-eq !>(`result:pg`[`'<b>' ~ %html ~ ~]) !>((html:pg '<b>')))
    (expect-eq !>(`result:pg`[`'# h' ~ %md ~ ~]) !>((md:pg '# h')))
    (expect-eq !>(`result:pg`[`'=> a' ~ %gmi ~ ~]) !>((gmi:pg '=> a')))
    (expect-eq !>(`result:pg`[`[1 2] ~ %noun ~ ~]) !>((raw:pg [1 2])))
    ::  +same writes nothing
    (expect-eq !>(`result:pg`[~ ~ %text ~ ~]) !>(same:pg))
  ==
::  Modifiers chain onto a result without disturbing the data.
::
++  test-modifiers
  =/  r=result:pg  (text:pg 'v')
  ;:  weld
    (expect-eq !>(~[/a/b]) !>(dep:(needs:pg r ~[/a/b])))
    (expect-eq !>(`'v') !>(dat:(needs:pg r ~[/a/b])))
    (expect-eq !>(`~s30) !>(wake:(every:pg r ~s30)))
    (expect-eq !>(~[[%other 'inc']]) !>(pokes:(sends:pg r ~[[%other 'inc']])))
    ::  chaining: needs then every keeps both
    =/  c=result:pg  (every:pg (needs:pg r ~[/d]) ~m1)
    ;:  weld
      (expect-eq !>(~[/d]) !>(dep.c))
      (expect-eq !>(`~m1) !>(wake.c))
    ==
  ==
::  Path builders point into the app's page tree.
::
++  test-path-builders
  ;:  weld
    %+  expect-eq
      !>  `path`/apps/'lattice.lattice_app'/page/counter/data
      !>  (data-of:pg %counter)
    %+  expect-eq
      !>  `path`/apps/'lattice.lattice_app'/page/counter/view
      !>  (view-of:pg %counter)
    %+  expect-eq
      !>  `path`/apps/'lattice.lattice_app'/page/blog/nested
      !>  (dir-of:pg /blog/nested)
    (expect-eq !>("/apps/lattice/c/blog/post") !>((pub-of:pg /blog/post)))
  ==
::  +shown pulls a view-dep's rendered html out of `deps`; missing or
::  wrongly-typed deps degrade to '' rather than crashing the page.
::
++  test-shown
  =/  deps=(list [path *])
    :~  [(view-of:pg %clock) '<b>tick</b>']
        [(data-of:pg %counter) '7']
    ==
  ;:  weld
    (expect-eq !>('<b>tick</b>') !>((shown:pg deps %clock)))
    (expect-eq !>('') !>((shown:pg deps %missing)))
    ::  a non-cord value at the view path yields '' (mole fallback)
    (expect-eq !>('') !>((shown:pg ~[[(view-of:pg %bad) [1 2 3]]] %bad)))
  ==
::  +tree-in extracts a directory dep's listing; +folder-index builds a nav
::  from it, skipping the conventional /index page, and stays live by
::  depending on the folder.
::
++  test-tree-in-and-folder-index
  =/  listing=(list entry:pg)  ~[[/post %.y] [/index %.y] [/drafts %.n]]
  =/  deps=(list [path *])  ~[[(dir-of:pg /blog) listing]]
  =/  r=result:pg  (folder-index:pg deps /blog)
  =/  body=tape  (trip ;;(@t (need dat.r)))
  ;:  weld
    (expect-eq !>(listing) !>((tree-in:pg deps /blog)))
    (expect-eq !>(`(list entry:pg)`~) !>((tree-in:pg deps /other)))
    ::  renders html, links the post via its public url
    (expect-eq !>(%html) !>(show.r))
    (expect-eq !>(%.y) !>(?=(^ (find "/apps/lattice/c/blog/post" body))))
    ::  the index page itself is skipped, folders are skipped
    (expect-eq !>(%.n) !>(?=(^ (find "index</a>" body))))
    (expect-eq !>(%.n) !>(?=(^ (find "drafts" body))))
    ::  stays live: depends on the folder
    (expect-eq !>(~[(dir-of:pg /blog)]) !>(dep.r))
  ==
--
