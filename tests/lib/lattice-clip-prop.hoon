::  Property tests for /lib/lattice-clip (the hand-rolled HTML tokenizer).
::
::  This lib eats clearweb pages and pasted content: 422 lines of hand-written
::  scanner over bytes nobody on this ship chose. The example tests next door
::  cover the shapes somebody thought of. What follows covers the shapes nobody
::  did.
::
::  Properties:
::    C1  +to-md is TOTAL           (no input crashes it)
::    C2  +page-title is TOTAL
::    C3  output growth is bounded  (no input makes it explode)
::    C4  boilerplate stays dropped (no <script in the output, ever)
::    C5  no dangerous URL survives (see the bypass writeup at the bottom)
::
::  C1 is the one that needs %quiz specifically: +mong catches the crash and
::  reports it as a refutation, so a bail in the code under test does not take
::  the test runner down with it. Note what it can NOT catch: +mong has no fuel
::  counter, so a scanner that loops forever hangs the ship and this file never
::  returns. That class is covered from outside by scripts/hoon-hang.sh.
::
::  Run: mcp/run-tests {desk:grubbery, path:/tests/lib/lattice-clip-prop}
::
/+  *test, quiz=lattice-quiz, fz=lattice-fuzz, clip=lattice-clip
|%
++  chk  ~(check quiz `@uv`0xc1.9fee 96)
::
::  +gen-html: token soup from the html pool. See /lib/lattice-fuzz for why a
::  type-driven generator is worthless against a grammar.
++  gen-html
  |=  [size=@ud rng=_og]
  ^-  @t
  (brew:fz html-pool:fz size rng)
::
::  +gen-hidden-payload: an executable/chrome tag whose CONTENT is a sentinel,
::  followed by arbitrary soup. The sentinel `zzqqxx` appears in no pool, so if
::  it reaches the output it got there through the dropped tag and nowhere else.
::  The soup goes INSIDE the dropped region on purpose: an unterminated tag or
::  a stray <main> in there changes which region the lib extracts, and the
::  property has to survive that too.
++  gen-hidden-payload
  |=  [size=@ud rng=_og]
  ^-  @t
  =^  inner  rng  (soup:fz html-pool:fz (min size 60) rng)
  =^  which  rng  (rads:rng 4)
  =/  nm=tape
    ?+  which  "script"
      %1  "style"
      %2  "iframe"
      %3  "form"
    ==
  (crip :(weld "<p>zzkeep</p><" nm ">zzqqxx" inner "</" nm ">"))
::
::  +gen-evil-href: a link whose href is a denylisted scheme with some leading
::  byte in front of it. This is the targeted generator for the finding at the
::  bottom of this file; token soup would hit the same bug eventually, but it
::  would also splatter the scheme into the output as ordinary prose, and a
::  refutation you cannot attribute is not a finding.
++  gen-evil-href
  |=  [size=@ud rng=_og]
  ^-  @t
  =^  lead  rng  (pick:fz lead-pool:fz rng)
  =^  sch   rng  (pick:fz scheme-pool:fz rng)
  =^  which  rng  (rads:rng 2)
  ?:  =(0 which)
    (crip :(weld "<a href=\"" lead sch "alert(1)\">x</a>"))
  (crip :(weld "<img src=\"" lead sch "alert(1)\" alt=\"x\">"))
::
::  ── C1/C2: totality ─────────────────────────────────────────────────────────
::
::  Reaching the last line IS the property: +mong reports a bail inside the lib
::  as a refutation. The size checks below stand in for `&`, so there is no
::  bound to tighten in either arm.
++  test-prop-to-md-total
  =/  fate=vase
    !>
    |=  h=@t
    ^-  ?
    =/  o=@t  (to-md:clip h)
    (gte (met 3 o) 0)
  (expect !>((chk fate `gen-html `cord-alts:fz)))
::
++  test-prop-page-title-total
  =/  fate=vase
    !>
    |=  h=@t
    ^-  ?
    =/  o=(unit @t)  (page-title:clip h)
    ?~(o & (gte (met 3 u.o) 0))
  (expect !>((chk fate `gen-html `cord-alts:fz)))
::
::  ── C3: bounded growth ──────────────────────────────────────────────────────
::
::  The converter is a single linear pass that appends only short literals, so
::  output size must stay a small multiple of input size. The worst per-byte
::  expansion in the table is <h6> (4 bytes in, "\n\n###### " 9 bytes out), so
::  4x plus a constant is generous. If this ever fails, some branch has started
::  re-emitting input it already consumed, which is the quadratic the lib's own
::  header says has wedged this ship before.
++  test-prop-to-md-bounded
  =/  fate=vase
    !>
    |=  h=@t
    ^-  ?
    =/  o=@t  (to-md:clip h)
    (lte (met 3 o) (add 64 (mul 4 (met 3 h))))
  (expect !>((chk fate `gen-html `cord-alts:fz)))
::
::  +page-title is a slice of the input, so it can only shrink.
++  test-prop-page-title-bounded
  =/  fate=vase
    !>
    |=  h=@t
    ^-  ?
    =/  o=(unit @t)  (page-title:clip h)
    ?~  o  &
    (lte (met 3 u.o) (add 8 (met 3 h)))
  (expect !>((chk fate `gen-html `cord-alts:fz)))
::
::  ── C4: executable content stays dropped ────────────────────────────────────
::
::  +drop-tag drops <script>/<style>/<iframe>/<form> together with their
::  content. The archived markdown is later rendered, so content that escaped
::  from inside a <script> would be a stored payload in whatever renders it.
::
::  Stated one-sided on purpose. "the payload is gone" is a property; "and the
::  surrounding text survives" is NOT, because +region reads the whole document
::  first and a <main>/<article>/<body> tag anywhere in the generated soup
::  legitimately reselects which slice of it gets converted at all.
++  test-prop-dropped-tag-content-never-survives
  =/  fate=vase
    !>
    |=  h=@t
    ^-  ?
    !(has-sub:fz "zzqqxx" (trip (to-md:clip h)))
  (expect !>((chk fate `gen-hidden-payload `cord-alts:fz)))
::
::  The same obligation for the title extractor, which slices the raw document
::  and never consults +drop-tag at all.
++  test-prop-title-never-leaks-payload
  =/  fate=vase
    !>
    |=  h=@t
    ^-  ?
    =/  o=(unit @t)  (page-title:clip h)
    ?~  o  &
    !(has-sub:fz "zzqqxx" (trip u.o))
  (expect !>((chk fate `gen-hidden-payload `cord-alts:fz)))
::
::  ── C5: FIXED. the scheme denylist was bypassable ───────────────────────────
::
::  /lib/lattice-clip guards link and image URLs with a DENYLIST:
::
::      ++  safe-url
::        |=  u=tape
::        =/  l=tape  (cass u)
::        ?&  !=("javascript:" (scag 11 l))
::            !=("data:" (scag 5 l))
::            ?=(^ u)
::        ==
::
::  It compares the first 11 (or 5) bytes against the scheme EXACTLY. Any byte
::  in front of the scheme shifts the window and the comparison misses: a
::  leading space, a tab, a newline, a NUL. +attr preserves that byte verbatim
::  (it reads to the closing quote and does not trim), so
::
::      <a href=" javascript:alert(1)">x</a>
::
::  emits  [x]( javascript:alert(1))  into the archive.
::
::  That is a live link, not inert text. CommonMark permits whitespace between
::  the '(' and the destination, so the renderer strips the space this check
::  relied on and produces href="javascript:alert(1)". The sanitiser and the
::  renderer disagree about what the URL is, which is the classic shape of a
::  sanitiser bypass.
::
::  Contrast /lib/lattice-md, which guards the SAME hazard with an ALLOWLIST
::  (+has is a prefix test for http://, https://, urb://, mailto:, then an
::  explicit relative-reference rule). A leading space defeats the allowlist
::  too, but it fails CLOSED: the URL is rejected and the link degrades to
::  text. The denylist fails OPEN. Same threat, opposite default, one codebase.
::
::  FIXED: +safe-url now strips leading whitespace and control bytes before
::  testing the scheme, via +lead-strip, so the window can no longer be slid.
::  These cases were written asserting the broken behaviour and went red the
::  moment the fix landed, which is how the fix was confirmed. They now assert
::  the property: no leading byte may smuggle a scheme past the check.
++  test-no-leading-byte-smuggles-a-scheme
  =/  m  to-md:clip
  ;:  weld
    ::  a leading space no longer defeats the javascript: check
    %+  expect-eq  !>(|)
    !>  (has-sub:fz "javascript:alert(1)" (trip (m '<a href=" javascript:alert(1)">x</a>')))
    ::  nor does a tab
    %+  expect-eq  !>(|)
    !>  (has-sub:fz "javascript:alert(1)" (trip (m '<a href="\09javascript:alert(1)">x</a>')))
    ::  nor a newline
    %+  expect-eq  !>(|)
    !>  (has-sub:fz "javascript:alert(1)" (trip (m '<a href="\0ajavascript:alert(1)">x</a>')))
    ::  data: is closed the same way
    %+  expect-eq  !>(|)
    !>  (has-sub:fz "data:text/html" (trip (m '<a href=" data:text/html,<b>">x</a>')))
    ::  and <img src=> is covered too, where the payload needs no click
    %+  expect-eq  !>(|)
    !>  (has-sub:fz "javascript:alert(1)" (trip (m '<img src=" javascript:alert(1)" alt="a">')))
    ::  CONTROL: the no-leading-byte case was always caught. Keeping it proves
    ::  these assertions track the scheme check rather than a broken +attr.
    %+  expect-eq  !>(|)
    !>  (has-sub:fz "javascript:" (trip (m '<a href="javascript:alert(1)">x</a>')))
  ==
::
::  And the generated form of the same finding, which is how it was FOUND
::  rather than a reconstruction. +gen-evil-href draws a leading byte from
::  +lead-pool and a scheme from +scheme-pool and builds a link or an image
::  from them; nothing else in the document can contribute a scheme, so a
::  refutation here is attributable to the href and to nothing else.
::
::  This asserts the property HOLDS. If it goes red, some leading byte again
::  slides the scheme window past +safe-url. Do not pin it back to a refutation
::  and do not delete it: this sweep is what found the bypass.
++  test-generated-evil-hrefs-never-reach-the-output
  =/  fate=vase
    !>
    |=  h=@t
    ^-  ?
    ::  case-folded: a denylist that ignores case is only meaningful if the
    ::  CHECK ignores case too.
    =/  o=tape  (cass (trip (to-md:clip h)))
    ?&  !(has-sub:fz "javascript:" o)
        !(has-sub:fz "data:" o)
    ==
  ::  the generated sweep that FOUND the bypass, now asserting it is closed:
  ::  no leading byte x scheme combination reaches the archived markdown.
  (expect-eq !>(&) !>((chk fate `gen-evil-href `cord-alts:fz)))
--
