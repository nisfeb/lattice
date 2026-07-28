::  /lib/lattice-md — a GitHub-Flavored Markdown -> HTML renderer (server-side).
::  Own-page content: raw HTML is escaped; only safe link schemes become hrefs.
::
|%
+$  refm  (map tape [url=tape title=tape])
+$  footm  (map tape [num=@ud text=tape])
::  +esc: HTML-escape a tape.
++  esc
  |=  t=tape
  ^-  tape
  %-  zing
  %+  turn  t
  |=  c=@tD
  ?+  c  ~[c]
    %'&'  "&amp;"
    %'<'  "&lt;"
    %'>'  "&gt;"
    %'"'  "&quot;"
  ==
::  scag/slag widen their arg to a GENERAL (nullable) tape: called on a
::  ?=/?~-refined non-null tape they mull-grow (scag/slag ^+ b, but can return ~).
++  sc  |=([n=@ud t=tape] ^-(tape (scag n t)))
++  sl  |=([n=@ud t=tape] ^-(tape (slag n t)))
++  sn  |=([n=@ud t=tape] ^-(@tD (snag n t)))
++  snl  |=([n=@ud t=(list tape)] ^-(tape (snag n t)))
++  rr  |=(t=tape ^-(@tD (rear t)))
++  has  |=([p=tape t=tape] =(p (sc (lent p) t)))
++  ltrm  |=(t=tape ^-(tape ?~(t t ?:(=(' ' i.t) $(t t.t) t))))
++  rtrm  |=(t=tape (flop (ltrm (flop t))))
++  trim  |=(t=tape (rtrm (ltrm t)))
++  lead  |=(t=tape =|(n=@ud |-(^-(@ud ?~(t n ?:(|(=(' ' i.t) =(`@tD`9 i.t)) $(t t.t, n +(n)) n))))))
::  +allrun: is `t` (after trimming) n>=need repeats of char set `cs`, nonempty?
++  allrun
  |=  [t=tape cs=tape need=@ud]
  ^-  ?
  =/  s=tape  (trim t)
  ?:  (lth (lent s) need)  |
  |-  ^-  ?  ?~(s & ?:((lien cs |=(c=@tD =(c i.s))) $(s t.s) |))
::  +safe-url: allow http(s)/urb/mailto/relative; block javascript:/data:/etc.
++  safe-url
  |=  u=tape
  ^-  ?
  =/  l=tape  (cass u)
  ?:  |((has "http://" l) (has "https://" l) (has "urb://" l) (has "mailto:" l))  &
  ?:  ?|(?=(~ u) =('/' i.u) =('#' i.u))  &
  ::  a relative ref has no scheme: no ':' before the first '/'
  =/  col  (find ":" l)
  =/  sl   (find "/" l)
  ?~  col  &
  ?~  sl   |
  (lth u.sl u.col)
++  a-html
  |=  [inner=tape url=tape title=tape]
  ^-  tape
  ?.  (safe-url url)  inner
  ::  a footnote reference (rewritten to #fn-id by sub-foot-refs) is superscript.
  ?:  (has "#fn-" url)
    :(weld "<sup class=\"fnref\"><a href=\"" (esc url) "\">" inner "</a></sup>")
  =/  ti=tape  ?~(title "" :(weld " title=\"" (esc title) "\""))
  ;:  weld
    "<a href=\""  (esc url)  "\""  ti
    " target=\"_blank\" rel=\"noopener noreferrer\">"  inner  "</a>"
  ==
++  img-html
  |=  [alt=tape url=tape title=tape]
  ^-  tape
  ?.  (safe-url url)  (esc alt)
  =/  ti=tape  ?~(title "" :(weld " title=\"" (esc title) "\""))
  :(weld "<img src=\"" (esc url) "\" alt=\"" (esc alt) "\"" ti " loading=\"lazy\">")
::  +scan-cap: how far an INLINE scan looks for its closing delimiter before
::  giving up and treating the opener as literal text.
::
::  Every unmatched inline delimiter used to cost a scan of the whole rest of
::  the paragraph, at EVERY position — so a paragraph of repeated "[[" (or
::  "**", or backticks) was quadratic. That is reachable from an
::  unauthenticated page render: 20KB of "[[" wedged the ship for hours.
::  Capping the lookahead bounds the worst case to cap*n instead of n^2.
::  2K is far longer than any real link text, code span or emphasis run, so
::  no realistic document renders differently.
++  scan-cap  ^~((mul 2 1.024))
::  +link-scan-cap: lookahead for a link's ( ) or [ref] tail. Reached only
::  after a bracket matched, so a tight bound is safe — real URLs and
::  reference labels are far shorter — and it stops "[a](" spam from costing
::  a full-tail scan per link.
++  link-scan-cap  ^~(512)
::  +find-cap: (find nedl hay), giving up after +scan-cap characters.
++  find-cap
  |=  [nedl=tape hay=tape cap=@ud]
  ^-  (unit @ud)
  =|  i=@ud
  |-  ^-  (unit @ud)
  ?:  (gth i cap)  ~
  ?~  hay  ~
  ?:  =(nedl (scag (lent nedl) `tape`hay))  `i
  $(hay t.hay, i +(i))
::  +match-bracket: index of the ] that closes the [ at position 0 (t is after
::  the opening [), honoring one level of nested []. Capped by +scan-cap.
++  match-bracket
  |=  t=tape
  ^-  (unit @ud)
  =|  [i=@ud d=@ud]
  |-  ^-  (unit @ud)
  ?~  t  ~
  ?:  =('[' i.t)  $(t t.t, i +(i), d +(d))
  ?:  =(']' i.t)  ?:(=(0 d) `i $(t t.t, i +(i), d (dec d)))
  $(t t.t, i +(i))
::  +take-paren: parse (url "title") starting at t (after the [text]); returns
::  [url title rest] where rest is after the closing ).
++  take-paren
  |=  t=tape
  ^-  (unit [url=tape title=tape rest=tape])
  ?~  t  ~
  ?.  =('(' i.t)  ~
  =/  close  (find-cap ")" t.t link-scan-cap)
  ?~  close  ~
  =/  guts=tape  (trim (sc u.close t.t))
  =/  rest=tape  (sl +(u.close) t.t)
  ::  optional "title" or 'title' at the end of guts
  =/  q  (find "\"" guts)
  ?~  q
    [~ guts "" rest]
  =/  url=tape  (trim (sc u.q guts))
  =/  aft=tape  (sl +(u.q) guts)
  =/  q2  (find "\"" aft)
  ?~  q2  [~ url "" rest]
  [~ url (sc u.q2 aft) rest]
::  +take-ref: parse [ref] starting at t (after [text]); look up in refs.
++  take-ref
  |=  [t=tape label=tape refs=refm]
  ^-  (unit [url=tape title=tape rest=tape])
  ?~  t  ~
  ?.  =('[' i.t)  ~
  =/  close  (find-cap "]" t.t link-scan-cap)
  ?~  close  ~
  =/  key0=tape  (sc u.close t.t)
  =/  rest=tape  (sl +(u.close) t.t)
  =/  key=tape  ?~(key0 label key0)         :: [text][] uses text as ref
  =/  hit  (~(get by refs) (cass key))
  ?~  hit  ~
  `[url.u.hit title.u.hit rest]
::  +ib: render inline markdown to HTML (with reference map).
++  ib
  |=  [t=tape refs=refm]
  ^-  tape
  (ib-in t refs *(set @tD))
::  +ib-in: +ib carrying `no` — the set of closing characters a previous scan
::  has PROVED absent from the rest of this tape.
::
::  The asymmetric delimiters ('[' needs ']', '<http' needs '>') were quadratic:
::  with no closer anywhere, every opener scanned the whole remaining paragraph
::  and failed, at every position. That is reachable from an unauthenticated
::  render — 20KB of '[[' wedged the ship for hours. A failed scan is conclusive
::  for the whole remaining tape (and for every suffix of it), so we record the
::  closer and skip the scan from then on. Output is byte-identical: the flag
::  only skips scans whose answer is already known. Symmetric delimiters (**,
::  ~~, backtick) are self-limiting — a repeated delimiter is its own closer —
::  and stay on the capped +find-cap.
++  ib-in
  |=  [t=tape refs=refm no=(set @tD)]
  ^-  tape
  ?~  t  ""
  =/  c=@tD  i.t
  ::  backslash escape
  ?:  ?&(=('\\' c) ?=(^ t.t))
    (weld (esc ~[i.t.t]) (ib-in t.t.t refs no))
  ::  code span (single or double backtick)
  ?:  =('`' c)
    =/  dbl=?  &(?=(^ t.t) =('`' i.t.t))
    =/  op=tape  ?:(dbl "``" "`")
    =/  aft=tape  (sl (lent op) t)
    =/  close  (find-cap op aft scan-cap)
    ?~  close  (weld "`" (ib-in t.t refs no))
    =/  code=tape  (sc u.close aft)
    %+  weld  :(weld "<code>" (esc (trim code)) "</code>")
    (ib-in (sl (add u.close (lent op)) aft) refs no)
  ::  image ![alt](url) or ![alt][ref] — same no-set guard as the link branch
  ::  below: a failed bracket scan is conclusive for the whole remaining tape,
  ::  so record it instead of re-scanning at every later '![' (20KB of "!["
  ::  was the same unauthenticated quadratic the link fix closed).
  ?:  ?&(=('!' c) ?=(^ t.t) =('[' i.t.t))
    ?:  (~(has in no) ']')  (weld "!" (ib-in t.t refs no))
    =/  aft=tape  (sl 2 t)          :: after ![
    =/  mb  (match-bracket aft)
    ?~  mb  (weld "!" (ib-in t.t refs (~(put in no) ']')))
    =/  alt=tape  (sc u.mb aft)
    =/  post=tape  (sl +(u.mb) aft)  :: after ]
    =/  p  (take-paren post)
    ?^  p
      (weld (img-html alt url.u.p title.u.p) (ib-in rest.u.p refs no))
    =/  r  (take-ref post alt refs)
    ?^  r
      (weld (img-html alt url.u.r title.u.r) (ib-in rest.u.r refs no))
    (weld "!" (ib-in t.t refs no))
  ::  autolink <http...>
  ?:  ?&(=('<' c) |((has "<http" t) (has "<https" t)) ?!((~(has in no) '>')))
    =/  close  (find ">" t.t)
    ?~  close  (weld "&lt;" (ib-in t.t refs (~(put in no) '>')))
    =/  url=tape  (sc u.close t.t)
    %+  weld  (a-html (esc url) url "")
    (ib-in (sl +(u.close) t.t) refs no)
  ::  link [text](url) or [text][ref] or [ref]
  ?:  =('[' c)
    ?:  (~(has in no) ']')  (weld "[" (ib-in t.t refs no))
    =/  mb  (match-bracket t.t)
    ?~  mb  (weld "[" (ib-in t.t refs (~(put in no) ']')))
    =/  txt=tape  (sc u.mb t.t)
    =/  post=tape  (sl +(u.mb) t.t)
    =/  p  (take-paren post)
    ?^  p
      (weld (a-html (ib-in txt refs no) url.u.p title.u.p) (ib-in rest.u.p refs no))
    =/  r  (take-ref post txt refs)
    ?^  r
      (weld (a-html (ib-in txt refs no) url.u.r title.u.r) (ib-in rest.u.r refs no))
    (weld "[" (ib-in t.t refs no))
  ::  bold+italic ***text***
  ?:  (has "***" t)
    =/  aft=tape  (sl 3 t)
    =/  cl  (find-cap "***" aft scan-cap)
    ?~  cl  (weld (esc ~[c]) (ib-in t.t refs no))
    %+  weld  :(weld "<strong><em>" (ib-in (sc u.cl aft) refs no) "</em></strong>")
    (ib-in (sl (add u.cl 3) aft) refs no)
  ::  bold **text** or __text__
  ?:  |((has "**" t) (has "__" t))
    =/  d=tape  (sc 2 t)
    =/  aft=tape  (sl 2 t)
    =/  cl  (find-cap d aft scan-cap)
    ?~  cl  (weld (esc ~[c]) (ib-in t.t refs no))
    %+  weld  :(weld "<strong>" (ib-in (sc u.cl aft) refs no) "</strong>")
    (ib-in (sl (add u.cl 2) aft) refs no)
  ::  strikethrough ~~text~~
  ?:  (has "~~" t)
    =/  aft=tape  (sl 2 t)
    =/  cl  (find-cap "~~" aft scan-cap)
    ?~  cl  (weld (esc ~[c]) (ib-in t.t refs no))
    %+  weld  :(weld "<del>" (ib-in (sc u.cl aft) refs no) "</del>")
    (ib-in (sl (add u.cl 2) aft) refs no)
  ::  italic *text* (asterisk: no intraword restriction)
  ?:  =('*' c)
    =/  cl  (find-cap "*" t.t scan-cap)
    ?~  cl  (weld "*" (ib-in t.t refs no))
    ?:  =(0 u.cl)  (weld "*" (ib-in t.t refs no))
    %+  weld  :(weld "<em>" (ib-in (sc u.cl t.t) refs no) "</em>")
    (ib-in (sl +(u.cl) t.t) refs no)
  ::  italic _text_ (underscore: only at a left word boundary)
  ?:  =('_' c)
    =/  cl  (find-cap "_" t.t scan-cap)
    ?~  cl  (weld "_" (ib-in t.t refs no))
    ?:  =(0 u.cl)  (weld "_" (ib-in t.t refs no))
    %+  weld  :(weld "<em>" (ib-in (sc u.cl t.t) refs no) "</em>")
    (ib-in (sl +(u.cl) t.t) refs no)
  ::  literal char
  (weld (esc ~[c]) (ib-in t.t refs no))
::  ── block level ────────────────────────────────────────────────────────────
::  +is-ref-def: a `[label]: url "title"` reference definition line -> entry.
++  is-ref-def
  |=  ln=tape
  ^-  (unit [key=tape url=tape title=tape])
  =/  s=tape  (trim ln)
  ?~  s  ~
  ?.  =('[' i.s)  ~
  =/  close  (find "]:" t.s)
  ?~  close  ~
  =/  key=tape  (sc u.close t.s)
  =/  rest=tape  (trim (sl (add u.close 2) t.s))
  ?~  rest  ~
  =/  q  (find " \"" rest)
  ?~  q  [~ (cass key) rest ""]
  =/  url=tape  (sc u.q rest)
  =/  ti=tape  (sl (add u.q 2) rest)
  =/  q2  (find "\"" ti)
  [~ (cass key) url ?~(q2 ti (sc u.q2 ti))]
::  +collect-refs: pull every reference-definition line out; return [refs kept].
++  collect-refs
  |=  lines=(list tape)
  ^-  [refm (list tape)]
  =|  refs=refm
  =|  kept=(list tape)
  |-  ^-  [refm (list tape)]
  ?~  lines  [refs (flop kept)]
  =/  rd  (is-ref-def i.lines)
  ?^  rd
    $(lines t.lines, refs (~(put by refs) key.u.rd [url.u.rd title.u.rd]))
  $(lines t.lines, kept [i.lines kept])
::  ── footnotes ─────────────────────────────────────────────────────────────
::  +is-foot-def: a `[^id]: text` footnote definition line -> [id text].
++  is-foot-def
  |=  ln=tape
  ^-  (unit [id=tape text=tape])
  =/  s=tape  (trim ln)
  ?.  (has "[^" s)  ~
  =/  close  (find "]:" s)
  ?~  close  ~
  =/  id=tape  (sc (sub u.close 2) (sl 2 s))
  ?~  id  ~
  `[id (trim (sl (add u.close 2) s))]
::  +collect-footnotes: pull `[^id]: text` definitions out and number them (in
::  order). The refs themselves are rewritten to links by +sub-foot-refs.
++  collect-footnotes
  |=  lines=(list tape)
  ^-  [footm (list tape)]
  =|  foot=footm
  =|  kept=(list tape)
  =/  n=@ud  0
  |-  ^-  [footm (list tape)]
  ?~  lines  [foot (flop kept)]
  =/  fd  (is-foot-def i.lines)
  ?^  fd
    $(lines t.lines, n +(n), foot (~(put by foot) id.u.fd [+(n) text.u.fd]))
  $(lines t.lines, kept [i.lines kept])
::  +sub-foot-refs: rewrite each `[^id]` reference whose id has a definition to
::  a `[num](#fn-id)` link (which +ib renders and +a-html superscripts).
++  sub-foot-refs
  |=  [t=tape foot=footm]
  ^-  tape
  ::  no definitions -> nothing can rewrite: skip the whole-document pass that
  ::  every footnote-free md render used to pay.
  ?:  =(0 ~(wyt by foot))  t
  |-  ^-  tape
  ?~  t  ""
  ?:  &(=('[' i.t) ?=(^ t.t) =('^' i.t.t))
    =/  aft=tape  (sl 2 t)
    ::  capped: a footnote id is short, and the uncapped find made 20KB of
    ::  "[^" spam quadratic on the unauthenticated render path.
    =/  close  (find-cap "]" aft link-scan-cap)
    ?~  close  (weld "[^" $(t t.t.t))
    =/  id=tape  (sc u.close aft)
    =/  hit  (~(get by foot) id)
    ?~  hit  (weld "[^" $(t aft))
    %+  weld  :(weld "[" (a-co:co num.u.hit) "](#fn-" id ")")
    $(t (sl +(u.close) aft))
  (weld ~[i.t] $(t t.t))
::  +render-footnotes: the numbered footnote list appended to the document.
++  render-footnotes
  |=  foot=footm
  ^-  tape
  ?:  =(0 ~(wyt by foot))  ""
  =/  items
    %+  sort  ~(tap by foot)
    |=([a=[id=tape num=@ud text=tape] b=[id=tape num=@ud text=tape]] (lth num.a num.b))
  =/  lis=tape
    %-  zing
    %+  turn  items
    |=  [id=tape num=@ud text=tape]
    ^-  tape
    (zing ~["<li id=\"fn-" (esc id) "\">" (ib text *refm) "</li>"])
  (zing ~["<hr class=\"fn-sep\"><ol class=\"footnotes\">" lis "</ol>"])
::  +setext-under: '===' -> 1 (h1), '---' -> 2 (h2), else 0.
++  setext-under
  |=  s=tape
  ^-  @ud
  ?:  (allrun s "=" 1)  1
  ?:  (allrun s "-" 2)  2
  0
::  +list-mark: parse a list-item line -> [indent ordered task content] or ~.
++  list-mark
  |=  ln=tape
  ^-  (unit [ind=@ud ord=? task=(unit ?) body=tape])
  =/  ind=@ud  (lead ln)
  =/  s=tape  (sl ind ln)
  ?~  s  ~
  ::  unordered: - * +  then a space
  ?:  &(?=(^ t.s) =(' ' i.t.s) |(=('-' i.s) =('*' i.s) =('+' i.s)))
    =/  rest=tape  (ltrm (sl 1 s))
    =^  task  rest  (take-task rest)
    [~ ind | task rest]
  ::  ordered: digits then . or ) then space
  =/  ds=@ud  (digs s)
  ?:  &((gth ds 0) (gth (lent s) ds) |(=('.' (sn ds s)) =(')' (sn ds s))))
    =/  aft=tape  (sl +(ds) s)
    ?.  ?|(?=(~ aft) =(' ' i.aft))  ~
    =/  rest=tape  (ltrm aft)
    =^  task  rest  (take-task rest)
    [~ ind & task rest]
  ~
++  digs  |=(t=tape =|(n=@ud |-(^-(@ud ?~(t n ?:(&((gte i.t '0') (lte i.t '9')) $(t t.t, n +(n)) n))))))
::  +take-task: strip a leading [ ] / [x] checkbox; report its state.
++  take-task
  |=  t=tape
  ^-  [(unit ?) tape]
  ?.  ?&  (gte (lent t) 4)
          =('[' (sn 0 t))
          =(']' (sn 2 t))
          ?|(=(' ' (sn 1 t)) =('x' (sn 1 t)) =('X' (sn 1 t)))
      ==
    [~ t]
  [`(gth (sn 1 t) ' ') (ltrm (sl 3 t))]
::  +take-fence: gather raw lines until the closing fence; return [body rest].
++  take-fence
  |=  [lines=(list tape) fence=tape]
  ^-  [(list tape) (list tape)]
  =|  body=(list tape)
  |-  ^-  [(list tape) (list tape)]
  ?~  lines  [(flop body) ~]
  ?:  (has fence (trim i.lines))  [(flop body) t.lines]
  $(lines t.lines, body [i.lines body])
++  fence-html
  |=  [lang=tape body=(list tape)]
  ^-  tape
  =/  cls=tape  ?~(lang "" :(weld " class=\"language-" (esc lang) "\""))
  =/  code=tape
    %-  zing
    %+  turn  body
    |=(l=tape (weld (esc l) "\0a"))
  :(weld "<pre><code" cls ">" code "</code></pre>")
::  +table-sep: is `s` a GFM table separator row (| :---: | --- |)?
++  table-sep
  |=  s=tape
  ^-  ?
  =/  t=tape  (trim s)
  ?:  ?=(~ (find "-" t))  |
  |-  ^-  ?
  ?~  t  &
  ?:  (lien "|:- " |=(c=@tD =(c i.t)))  $(t t.t)
  |
::  +split-row: split a `| a | b |` line into trimmed cells.
++  split-row
  |=  ln=tape
  ^-  (list tape)
  =/  s=tape  (trim ln)
  =.  s  ?:(&(?=(^ s) =('|' i.s)) (sl 1 s) s)
  =.  s  ?:(&(?=(^ s) =('|' (rr s))) (sc (dec (lent s)) s) s)
  %+  turn  (split-pipe s)
  |=(c=tape (trim c))
::  +split-pipe: split on unescaped '|'.
++  split-pipe
  |=  t=tape
  ^-  (list tape)
  =|  [cur=tape out=(list tape)]
  |-  ^-  (list tape)
  ?~  t  (flop [(flop cur) out])
  ?:  &(=('\\' i.t) ?=(^ t.t) =('|' i.t.t))
    $(t t.t.t, cur ['|' cur])
  ?:  =('|' i.t)  $(t t.t, cur ~, out [(flop cur) out])
  $(t t.t, cur [i.t cur])
::  +take-table: header line + separator + rows -> <table>; return [html rest].
++  take-table
  |=  [lines=(list tape) refs=refm]
  ^-  [tape (list tape)]
  ?~  lines  ["" ~]
  ::  a table needs a separator row; rb only calls us when one exists, but the
  ::  compiler needs the guard to reach i.t.lines / t.t.lines.
  ?~  t.lines  ["" lines]
  =/  heads=(list tape)  (split-row i.lines)
  =/  aligns=(list tape)
    %+  turn  (split-row i.t.lines)
    |=  c=tape
    ^-  tape
    =/  l=?  &(?=(^ c) =(':' i.c))
    =/  r=?  &(?=(^ c) =(':' (rr c)))
    ?:  &(l r)  " style=\"text-align:center\""
    ?:  r  " style=\"text-align:right\""
    ?:  l  " style=\"text-align:left\""
    ""
  ::  cells and aligns walk together — the old gulf+snag indexing re-walked
  ::  both lists per column, O(columns^2) per row on the unauthenticated
  ::  render path (a single 20KB row was ~100M steps).
  =/  hcells=tape  (zing (cells-html heads aligns refs "th"))
  =/  hd=tape  (zing ~["<thead><tr>" hcells "</tr></thead>"])
  =/  trr  (take-table-rows t.t.lines)
  =/  rows=(list tape)  -.trr
  =/  rest=(list tape)  +.trr
  =/  brows=tape
    %-  zing
    %+  turn  rows
    |=  r=tape
    ^-  tape
    =/  tds=tape  (zing (cells-html (split-row r) aligns refs "td"))
    (zing ~["<tr>" tds "</tr>"])
  =/  bd=tape  (zing ~["<tbody>" brows "</tbody>"])
  [(zing ~["<table>" hd bd "</table>"]) rest]
::  +cells-html: one <th>/<td> per cell, cells and aligns consumed in step.
++  cells-html
  |=  [cells=(list tape) aligns=(list tape) refs=refm tag=tape]
  ^-  (list tape)
  ?~  cells  ~
  :_  $(cells t.cells, aligns ?~(aligns ~ t.aligns))
  :(weld "<" tag ?~(aligns "" i.aligns) ">" (ib i.cells refs) "</" tag ">")
++  take-table-rows
  |=  lines=(list tape)
  ^-  [(list tape) (list tape)]
  =|  rows=(list tape)
  |-  ^-  [(list tape) (list tape)]
  ?~  lines  [(flop rows) ~]
  ?:  ?|(?=(~ (trim i.lines)) ?=(~ (find "|" i.lines)))  [(flop rows) lines]
  $(lines t.lines, rows [i.lines rows])
::  +take-quote: gather '>'-prefixed lines, strip one '>', recurse.
++  take-quote
  |=  [lines=(list tape) refs=refm]
  ^-  [tape (list tape)]
  =|  inner=(list tape)
  |-  ^-  [tape (list tape)]
  ?:  ?&(?=(^ lines) =('>' (trim-head i.lines)))
    =/  s=tape  (ltrm i.lines)
    =/  stripped=tape  (ltrm (sl 1 s))    :: drop one '>' and a space
    $(lines t.lines, inner [stripped inner])
  [:(weld "<blockquote>" (rb (flop inner) refs) "</blockquote>") lines]
++  trim-head  |=(t=tape =/(s (ltrm t) ?~(s '0' i.s)))
::  +take-para: gather consecutive plain lines into a paragraph; return [html rest].
++  take-para
  |=  [lines=(list tape) refs=refm]
  ^-  [tape (list tape)]
  =|  buf=(list tape)
  |-  ^-  [tape (list tape)]
  ?:  ?&  ?=(^ lines)
          ?=(^ (trim i.lines))
          ?!((block-start lines))
      ==
    $(lines t.lines, buf [i.lines buf])
  =/  txt=tape  (join-para (flop buf))
  [:(weld "<p>" (ib txt refs) "</p>") lines]
::  +join-para: join lines with a space; two trailing spaces -> <br>.
++  join-para
  |=  ls=(list tape)
  ^-  tape
  ?~  ls  ""
  ?~  t.ls  (rtrm i.ls)
  =/  br=?  &((gte (lent i.ls) 2) =("  " (sl (sub (lent i.ls) 2) i.ls)))
  :(weld (rtrm i.ls) ?:(br "<br>" " ") $(ls t.ls))
::  +block-start: does the FIRST line begin a non-paragraph block?
++  block-start
  |=  lines=(list tape)
  ^-  ?
  ?~  lines  |
  =/  s=tape  (trim i.lines)
  ?~  s  &
  ?:  =('#' i.s)  &
  ?:  =('>' i.s)  &
  ?:  |((has "```" s) (has "~~~" s))  &
  ?:  |((allrun s "-" 3) (allrun s "*" 3) (allrun s "_" 3))  &
  ?:  ?=(^ (list-mark i.lines))  &
  ?:  &(?=(^ (find "|" s)) ?=(^ t.lines) (table-sep (trim i.t.lines)))  &
  ?:  &(?=(^ t.lines) (gth (setext-under (trim i.t.lines)) 0))  &
  |
::  +take-list: parse a list block into nested <ul>/<ol>; return [html rest].
++  take-list
  |=  [lines=(list tape) refs=refm]
  ^-  [tape (list tape)]
  =|  items=(list [ind=@ud ord=? task=(unit ?) body=tape])
  =/  blanks=@ud  0
  |^  ^-  [tape (list tape)]
      ?~  lines  [(render items) ~]
      =/  lm  (list-mark i.lines)
      ?^  lm
        %=  $
          lines   t.lines
          blanks  0
          items   [u.lm items]
        ==
      ?:  ?=(~ (trim i.lines))
        ?:  (gth blanks 0)  [(render items) lines]
        =/  nxt  ?~(t.lines ~ (list-mark i.t.lines))
        ?~  nxt  [(render items) lines]
        $(lines t.lines, blanks +(blanks))
      ::  an indented continuation line: append to the current item's body
      ?:  &(?=(^ items) (gth (lead i.lines) ind.i.items))
        =/  merged=tape  :(weld body.i.items " " (trim i.lines))
        $(lines t.lines, blanks 0, items [i.items(body merged) t.items])
      [(render items) lines]
  ::  +render: flat-stack nesting via deferred </li>. Output accumulates as a
  ::  LIST of chunks zinged once at the end — the old shape welded every item
  ::  onto one growing tape, re-copying the whole document per item (quadratic
  ::  in list size, reachable from the unauthenticated render).
  ++  render
    |=  its=(list [ind=@ud ord=? task=(unit ?) body=tape])
    ^-  tape
    =/  seq  (flop its)
    =/  stack=(list [ind=@ud ord=?])  ~
    =/  acc=(list tape)  ~
    |-  ^-  tape
    ?~  seq
      ?~  stack  (zing (flop acc))
      $(stack t.stack, acc [:(weld "</li>" ?:(ord.i.stack "</ol>" "</ul>")) acc])
    =/  it  i.seq
    =/  aj  (adjust stack ind.it ord.it)
    =.  acc  (weld (flop -.aj) acc)
    =.  stack  +.aj
    =/  cb=tape
      ?~  task.it  ""
      ?:(u.task.it "<input type=\"checkbox\" checked disabled> " "<input type=\"checkbox\" disabled> ")
    =.  acc  [:(weld "<li>" cb (ib body.it refs)) acc]
    $(seq t.seq)
  ::  +adjust: the chunks to emit (in order) + the new stack, so the top of
  ::  the stack matches [ind ord].
  ++  adjust
    |=  [stack=(list [ind=@ud ord=?]) ind=@ud ord=?]
    ^-  [(list tape) (list [ind=@ud ord=?])]
    =/  acc=(list tape)  ~
    |-  ^-  [(list tape) (list [ind=@ud ord=?])]
    ?~  stack
      [(flop [?:(ord "<ol>" "<ul>") acc]) [ind ord]~]
    ?:  (lth ind ind.i.stack)
      $(acc [:(weld "</li>" ?:(ord.i.stack "</ol>" "</ul>")) acc], stack t.stack)
    ?:  =(ind ind.i.stack)
      ::  same indent, same marker kind: next item of the same list.
      ?:  =(ord ord.i.stack)
        [(flop ["</li>" acc]) stack]
      ::  same indent, marker kind changed (bullet<->number): GFM starts a new
      ::  list — close this one and open the other.
      :_  [[ind ord] t.stack]
      (flop [:(weld "</li>" ?:(ord.i.stack "</ol>" "</ul>") ?:(ord "<ol>" "<ul>")) acc])
    [(flop [?:(ord "<ol>" "<ul>") acc]) [[ind ord] stack]]
  --
::  +rb: render a list of block lines to HTML.
++  rb
  |=  [lines=(list tape) refs=refm]
  ^-  tape
  ?~  lines  ""
  =/  ln=tape  i.lines
  =/  s=tape  (trim ln)
  ?:  ?=(~ s)  (rb t.lines refs)
  ::  fenced code
  ?:  |((has "```" s) (has "~~~" s))
    =/  fence=tape  (sc 3 s)
    =/  lang=tape  (trim (sl 3 s))
    =/  fr=[(list tape) (list tape)]  (take-fence t.lines fence)
    (weld (fence-html lang -.fr) (rb +.fr refs))
  ::  hr
  ?:  |((allrun s "-" 3) (allrun s "*" 3) (allrun s "_" 3))
    (weld "<hr>" (rb t.lines refs))
  ::  atx heading
  ?:  =('#' i.s)
    =/  n=@ud  (lead-hash s)
    ?:  &((gth n 0) (lte n 6))
      =/  txt=tape  (trim (hash-strip (sl n s)))
      =/  tag=tape  (weld "h" (a-co:co n))
      (weld :(weld "<" tag ">" (ib txt refs) "</" tag ">") (rb t.lines refs))
    =/  pr=[tape (list tape)]  (take-para lines refs)
    (weld -.pr (rb +.pr refs))
  ::  setext heading
  ?:  &(?=(^ t.lines) (gth (setext-under (trim i.t.lines)) 0))
    =/  lvl=@ud  (setext-under (trim i.t.lines))
    =/  tag=tape  ?:(=(1 lvl) "h1" "h2")
    (weld :(weld "<" tag ">" (ib s refs) "</" tag ">") (rb t.t.lines refs))
  ::  blockquote
  ?:  =('>' i.s)
    =/  qr=[tape (list tape)]  (take-quote lines refs)
    (weld -.qr (rb +.qr refs))
  ::  table
  ?:  &(?=(^ (find "|" s)) ?=(^ t.lines) (table-sep (trim i.t.lines)))
    =/  tr=[tape (list tape)]  (take-table lines refs)
    (weld -.tr (rb +.tr refs))
  ::  list
  ?:  ?=(^ (list-mark ln))
    =/  lr=[tape (list tape)]  (take-list lines refs)
    (weld -.lr (rb +.lr refs))
  ::  paragraph
  =/  pr=[tape (list tape)]  (take-para lines refs)
  (weld -.pr (rb +.pr refs))
++  lead-hash  |=(t=tape =|(n=@ud |-(^-(@ud ?~(t n ?:(=('#' i.t) $(t t.t, n +(n)) n))))))
++  hash-strip  |=(t=tape (rtrm (flop (ltrm-hash (flop (rtrm t))))))
++  ltrm-hash  |=(t=tape ^-(tape ?~(t t ?:(|(=('#' i.t) =(' ' i.t)) $(t t.t) t))))
::  +render-md: markdown body -> HTML fragment.
::  +cap-quote-depth: bound a line's leading '>' run at 32. +take-quote strips
::  ONE '>' per full re-render pass, so an adversarial 20KB line of '>' was
::  ~400M steps (quadratic in depth) on the unauthenticated render; capping
::  the depth bounds it at 32 passes and is byte-identical below the cap.
++  cap-quote-depth
  |=  l=tape
  ^-  tape
  =/  n=@ud  0
  =/  s=tape  l
  |-  ^-  tape
  ?:  &(?=(^ s) =('>' i.s))  $(s t.s, n +(n))
  ?:  (lte n 32)  l
  (weld `tape`(reap 32 '>') `tape`s)
++  render-md
  |=  body=@t
  ^-  tape
  =/  lines0=(list tape)  (turn (turn (to-wain:format body) trip) cap-quote-depth)
  =/  fn=[footm (list tape)]  (collect-footnotes lines0)
  =/  foot=footm  -.fn
  =/  lines1=(list tape)  (turn +.fn |=(l=tape (sub-foot-refs l foot)))
  =/  cr=[refm (list tape)]  (collect-refs lines1)
  (weld (rb +.cr -.cr) (render-footnotes foot))
--

