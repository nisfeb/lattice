::  Unit tests for /lib/lattice-know-view (the reader's knowledge view).
::
/+  *test, kv=lattice-know-view
|%
++  has  |=([n=tape h=tape] ^-(? ?=(^ (find n h))))
++  yes  |=(c=? (expect-eq !>(&) !>(c)))
++  one
  |=  [k=path body=@t tags=(list @t)]
  (malt ~[[k [body ~2026.1.1 (silt tags) ~]]])
::  a long first line is cut with one ellipsis character entity, not the
::  text of one, and never inside a UTF-8 character
++  test-preview-ellipsis
  =/  long=@t  (crip (weld (reap 120 'a') " <b>"))
  =/  h=tape  (know-quick-html:kv (one /k long ~) 5)
  =/  cjk=tape  (know-quick-html:kv (one /k (crip (zing (reap 40 "日"))) ~) 5)
  ;:  weld
    (yes (has (weld (reap 90 'a') "&hellip;</span>") h))
    (yes !(has "&amp;hellip;" h))
    ::  90 bytes is 30 whole characters
    (yes (has (weld `tape`(zing (reap 30 "日")) "&hellip;") cjk))
    ::  91 bytes in, the cut is inside the 31st character
    =/  off=tape  (know-quick-html:kv (one /k (crip (weld "a" `tape`(zing (reap 40 "日")))) ~) 5)
    (yes (has (weld "a" (weld `tape`(zing (reap 29 "日")) "&hellip;")) off))
    ::  a short line is escaped and whole
    (yes (has "a &lt;b&gt; &amp; c</span>" (know-quick-html:kv (one /k 'a <b> & c\0asecond' ~) 5)))
  ==
::  the preview is the first line of the prose, not the front matter's
::  opening fence
++  test-preview-prose
  =/  h=tape  (know-quick-html:kv (one /k '---\0acreated: 2026-01-01\0aauthor: x\0a---\0a\0athe fact\0amore' ~) 5)
  ;:  weld
    (yes (has "the fact</span>" h))
    (yes !(has "---" h))
    (yes !(has "created" h))
  ==
::  a tag link is percent-encoded, so the route reads the tag back whole
++  test-tag-links
  =/  es  (one /k 'x' ~['c++' 'r&d' 'c#' 'plain'])
  =/  chips=tape  (tag-chips:kv es '')
  =/  leaf=tape  (know-entry-html:kv /k [body='x' updated=~2026.1.1 tags=(silt `(list @t)`~['c++' 'r&d']) links=~])
  ;:  weld
    (yes (has "know?tag=c%2B%2B\"" chips))
    (yes (has "know?tag=r%26d\"" chips))
    (yes (has "know?tag=c%23\"" chips))
    (yes (has "know?tag=plain\"" chips))
    (yes (has ">#c++</a>" chips))
    (yes (has ">#r&amp;d</a>" chips))
    (yes (has "know?tag=c%2B%2B\"" leaf))
    (yes (has "know?tag=r%26d\"" leaf))
  ==
--
