::  Unit tests for +forum-css in /lib/lattice-forum-render: the stylesheet
::  must use lattice's theme variables (not furum's), each with a fallback,
::  so the forum is legible and themed.
::
/+  *test, fr=lattice-forum-render
|%
++  css  (trip forum-css:fr)
++  has  |=([n=tape h=tape] ?=(^ (find n h)))
::  +bare: count var( uses with no comma before their closing paren
::
++  bare
  |=  t=tape
  ^-  @ud
  =/  at  (find "var(" t)
  ?~  at  0
  =/  rest=tape  (slag (add u.at 4) t)
  =/  cm  (find "," rest)
  =/  cl  (find ")" rest)
  =/  bad=@ud  ?:(?&(?=(^ cm) ?=(^ cl) (lth u.cm u.cl)) 0 1)
  (add bad $(t rest))
++  test-no-furum-names
  =/  names=(list tape)
    :~  "var(--title"  "var(--primary"  "var(--on-primary"  "var(--surface"
        "var(--on-surface"  "var(--pin"  "var(--faint"  "var(--line"
        "var(--input"
    ==
  %+  expect-eq  !>(`(list tape)`~)
  !>(`(list tape)`(skim names |=(n=tape (has n css))))
++  test-has-lattice-names
  =/  names=(list tape)
    :~  "var(--accent,"  "var(--border-soft,"  "var(--border,"  "var(--raised,"
        "var(--pop,"  "var(--on-accent,"  "var(--text,"  "var(--bg,"
        "var(--link,"  "var(--muted,"
    ==
  %+  expect-eq  !>(`(list tape)`~)
  !>(`(list tape)`(skip names |=(n=tape (has n css))))
++  test-every-var-has-fallback
  (expect-eq !>(0) !>((bare css)))
--
