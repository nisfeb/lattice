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
--
