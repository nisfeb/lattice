::  /lib/lattice-geojson: a map page (a .geojson body) on the ship.
::
::  A map page holds a GeoJSON FeatureCollection. +gj-check says whether
::  a body may be saved, and why not. +gj-html draws the features as an
::  SVG outline with a table of them, for the reader, the preview and
::  the published views. +gj-text is the words for search, and +gj-title
::  the page title. +gj-all gives all three from one parse.
::
::  NO TILES. The SVG is the features on a blank background in an
::  equirectangular projection fitted to their bounds, so a render
::  fetches nothing and leaks nothing.
::
::  The HTML is built, never copied. The tags are div, svg, rect, path,
::  circle, title, table, thead, tbody, tr, th, td and p. Every name,
::  kind, time and number is escaped, and a colour is used only when it
::  is a #rgb or #rrggbb hex. A note is searched but not shown.
::
::  CAPS. A body over +max-size, nested deeper than +max-depth, with
::  more than +max-feats features or +max-pos positions, is refused on
::  save. The depth is checked by a scan before the parse, since the
::  JSON parser's cost grows faster than the depth. A render draws at
::  most +max-draw positions, every nth when there are more, and lists
::  the first +max-show features. Every entry point runs under +mule,
::  so a hostile body gives the note, never a crash.
::
|%
++  max-size   ^~((bex 22))
++  max-depth  64
++  max-feats  20.000
++  max-pos    500.000
++  max-draw   5.000
++  max-show   2.000
::  a body this small cannot nest deep enough to cost anything
++  scan-from  16.384
++  note-html  "<p class=\"geojson-note\">page too large or not previewable</p>"
::  +html-pres: how every +gj-html output starts, the map or the note
++  html-pres  `(list @t)`~['<div class="geojson">' '<p class="geojson-note">']
::  a feature as the render reads it
+$  part  [k=?(%pt %ln %pg) ps=(list json)]
+$  feat
  $:  name=(unit @t)
      kind=(unit @t)
      time=(unit @t)
      note=(unit @t)
      color=(unit @t)
      gtype=@t
      parts=(list part)
  ==
::
::  ── checking ──────────────────────────────────────────────────────
::
::  +gj-check: ~ when `body` may be saved as a map page, else why not
++  gj-check
  |=  body=@t
  ^-  (unit @t)
  =/  c  (checked body)
  ?:(?=(%& -.c) ~ `p.c)
::  +checked: the parsed body when it is a map page's, else why not
++  checked
  |=  body=@t
  ^-  (each json @t)
  ?:  (gth (met 3 body) max-size)  |+'that map is over 4 MB'
  ?.  (depth-ok body)  |+'that map nests deeper than GeoJSON does'
  =/  j=(unit json)  (de:json:html body)
  ?~  j  |+'that map is not valid JSON'
  =/  r  (mule |.((check-fc u.j)))
  ?:  ?=(%| -.r)  |+'that map is not valid GeoJSON'
  ?^  p.r  |+u.p.r
  &+u.j
::  +depth-ok: whether no array or object in `body` is nested deeper
::  than +max-depth. Brackets inside strings do not count.
++  depth-ok
  |=  body=@t
  ^-  ?
  ?:  (lte (met 3 body) scan-from)  &
  =/  bs=(list @)  (rip 3 body)
  =/  d=@ud  0
  =/  s=?  |
  |-  ^-  ?
  ?~  bs  &
  =/  c=@  i.bs
  ?:  s
    ?:  =('"' c)  $(bs t.bs, s |)
    ?:  =('\\' c)  ?~(t.bs & $(bs t.t.bs))
    $(bs t.bs)
  ?:  =('"' c)  $(bs t.bs, s &)
  ?:  |(=('[' c) =('{' c))
    ?:  (gte d max-depth)  |
    $(bs t.bs, d +(d))
  ?:  |(=(']' c) =('}' c))  $(bs t.bs, d ?:(=(0 d) 0 (dec d)))
  $(bs t.bs)
::  +check-fc: ~, or why a parsed body is not a map page's
++  check-fc
  |=  j=json
  ^-  (unit @t)
  ?.  ?=([%o *] j)  `'a map page must be a GeoJSON FeatureCollection'
  ?.  =(`s+'FeatureCollection' (~(get by p.j) 'type'))
    `'a map page must be a GeoJSON FeatureCollection'
  =/  lat  (~(get by p.j) 'lattice')
  ?:  &(?=(^ lat) !(lattice-ok u.lat))
    `'the lattice member of that map is not an object of view settings'
  =/  fs  (~(get by p.j) 'features')
  ?.  ?=([~ %a *] fs)  `'a FeatureCollection needs a features array'
  ?:  (gth (lent p.u.fs) max-feats)  `'that map has over 20,000 features'
  =/  n=@ud  0
  =/  l=(list json)  p.u.fs
  |-  ^-  (unit @t)
  ?~  l  ~
  =/  c=(each @ud @t)  (check-feat i.l)
  ?:  ?=(%| -.c)  `p.c
  =.  n  (add n p.c)
  ?:  (gth n max-pos)  `'that map has over 500,000 positions'
  $(l t.l)
::  +lattice-ok: the view member: an object, its layers a list of names
++  lattice-ok
  |=  j=json
  ^-  ?
  ?.  ?=([%o *] j)  |
  =/  ly  (~(get by p.j) 'layers')
  ?~  ly  &
  ?.  ?=([%a *] u.ly)  |
  (levy p.u.ly |=(x=json ?=([%s *] x)))
::  +check-feat: a feature's position count, or why it is not one
++  check-feat
  |=  j=json
  ^-  (each @ud @t)
  ?.  ?=([%o *] j)  |+'each feature must be an object'
  ?.  =(`s+'Feature' (~(get by p.j) 'type'))  |+'each feature must have type Feature'
  =/  pr=json  (fall (~(get by p.j) 'properties') ~)
  ?.  |(?=(~ pr) ?=([%o *] pr))
    |+'a feature\'s properties must be an object or null'
  =/  g=json  (fall (~(get by p.j) 'geometry') ~)
  ?~  g  &+0
  =/  c=(unit @ud)  (geom-count g &)
  ?~  c  |+'a feature has a geometry GeoJSON does not define'
  &+u.c
::  +geom-count: the positions in a geometry, ~ when it is not one. A
::  GeometryCollection holds plain geometries only (`top`).
++  geom-count
  |=  [g=json top=?]
  ^-  (unit @ud)
  ?.  ?=([%o *] g)  ~
  =/  t=(unit json)  (~(get by p.g) 'type')
  ?~  t  ~
  =/  ty=json  u.t
  ?.  ?=([%s *] ty)  ~
  ?:  =('GeometryCollection' p.ty)
    ?.  top  ~
    =/  gs=(unit json)  (~(get by p.g) 'geometries')
    ?~  gs  ~
    ?.  ?=([%a *] u.gs)  ~
    =/  l=(list json)  p.u.gs
    =/  n=@ud  0
    |-  ^-  (unit @ud)
    ?~  l  `n
    =/  c=(unit @ud)  (geom-count i.l |)
    ?~  c  ~
    $(l t.l, n (add n u.c))
  =/  cs=(unit json)  (~(get by p.g) 'coordinates')
  ?~  cs  ~
  =/  c=json  u.cs
  ?:  =('Point' p.ty)  ?:((pos-ok c) `1 ~)
  ?:  =('MultiPoint' p.ty)  (poss c 0)
  ?:  =('LineString' p.ty)  (poss c 2)
  ?:  =('MultiLineString' p.ty)  (nest c 2 1)
  ?:  =('Polygon' p.ty)  (nest c 4 1)
  ?:  =('MultiPolygon' p.ty)  (nest c 4 2)
  ~
::  +pos-ok: [lon, lat], with a height and a measure at most, all numbers
++  pos-ok
  |=  j=json
  ^-  ?
  ?.  ?=([%a *] j)  |
  =/  n  (lent p.j)
  ?.  &((gte n 2) (lte n 4))  |
  (levy p.j |=(x=json ?=([%n *] x)))
::  +poss: a list of at least `min` positions, and how many
++  poss
  |=  [j=json min=@ud]
  ^-  (unit @ud)
  ?.  ?=([%a *] j)  ~
  ?.  (levy p.j pos-ok)  ~
  =/  n  (lent p.j)
  ?:  (lth n min)  ~
  `n
::  +nest: `d` levels of lists over lists of at least `min` positions
++  nest
  |=  [j=json min=@ud d=@ud]
  ^-  (unit @ud)
  ?:  =(0 d)  (poss j min)
  ?.  ?=([%a *] j)  ~
  =/  l=(list json)  p.j
  =/  n=@ud  0
  |-  ^-  (unit @ud)
  ?~  l  `n
  =/  c=(unit @ud)  ^$(j i.l, d (dec d))
  ?~  c  ~
  $(l t.l, n (add n u.c))
::
::  ── reading ───────────────────────────────────────────────────────
::
::  +doc-of: the parsed body, when it passes +gj-check
++  doc-of
  |=  body=@t
  ^-  (unit json)
  =/  c  (checked body)
  ?:(?=(%& -.c) `p.c ~)
::  +str: a string member of an object, cut to `n` bytes
++  str
  |=  [o=(map @t json) k=@t n=@ud]
  ^-  (unit @t)
  =/  v  (~(get by o) k)
  ?.  ?=([~ %s *] v)  ~
  ?:  =('' p.u.v)  ~
  `(end [3 n] p.u.v)
::  +props: a feature's properties, ~ when there are none
++  props
  |=  f=(map @t json)
  ^-  (map @t json)
  =/  p  (~(get by f) 'properties')
  ?.  ?=([~ %o *] p)  ~
  p.u.p
::  +feats: the features of a parsed body, as the render reads them
++  feats
  |=  j=json
  ^-  (list feat)
  ?.  ?=([%o *] j)  ~
  =/  fs  (~(get by p.j) 'features')
  ?.  ?=([~ %a *] fs)  ~
  %+  turn  p.u.fs
  |=  f=json
  ^-  feat
  ?.  ?=([%o *] f)  *feat
  =/  p  (props p.f)
  =/  g  (~(get by p.f) 'geometry')
  =/  gm=json  ?~(g ~ u.g)
  :*  (str p 'name' 200)
      (str p 'kind' 40)
      (str p 'time' 40)
      (str p 'note' 4.096)
      (hex (str p 'color' 7))
      ?.(?=([%o *] gm) '' (fall (str p.gm 'type' 40) ''))
      (parts-of gm)
  ==
::  +hex: a colour, when it is #rgb or #rrggbb
++  hex
  |=  c=(unit @t)
  ^-  (unit @t)
  ?~  c  ~
  =/  t=tape  (trip u.c)
  ?.  ?=([%'#' *] t)  ~
  ?.  |(=(3 (lent t.t)) =(6 (lent t.t)))  ~
  ?.  (levy t.t |=(x=@tD ?|(&((gte x '0') (lte x '9')) &((gte x 'a') (lte x 'f')) &((gte x 'A') (lte x 'F')))))  ~
  c
::  +parts-of: a geometry as points, lines and polygon rings
++  parts-of
  |=  g=json
  ^-  (list part)
  ?.  ?=([%o *] g)  ~
  =/  t=(unit json)  (~(get by p.g) 'type')
  ?~  t  ~
  =/  ty=json  u.t
  ?.  ?=([%s *] ty)  ~
  ?:  =('GeometryCollection' p.ty)
    =/  gs=(unit json)  (~(get by p.g) 'geometries')
    ?~  gs  ~
    (zing (turn (ar u.gs) parts-of))
  =/  cs=(unit json)  (~(get by p.g) 'coordinates')
  ?~  cs  ~
  =/  c=json  u.cs
  ?:  =('Point' p.ty)  ~[[%pt ~[c]]]
  ?:  =('MultiPoint' p.ty)  ~[[%pt (ar c)]]
  ?:  =('LineString' p.ty)  ~[[%ln (ar c)]]
  ?:  =('MultiLineString' p.ty)  (turn (ar c) |=(x=json `part`[%ln (ar x)]))
  ?:  =('Polygon' p.ty)  ~[[%pg (zing (turn (ar c) ar))]]
  ?:  =('MultiPolygon' p.ty)
    (turn (ar c) |=(x=json `part`[%pg (zing (turn (ar x) ar))]))
  ~
::  +ar: an array's items, ~ for anything else
++  ar
  |=  j=json
  ^-  (list json)
  ?.  ?=([%a *] j)  ~
  p.j
::  +title-of: the collection's lattice.title, else the first name
++  title-of
  |=  j=json
  ^-  (unit @t)
  ?.  ?=([%o *] j)  ~
  =/  l  (~(get by p.j) 'lattice')
  =/  t=(unit @t)  ?.(?=([~ %o *] l) ~ (str p.u.l 'title' 200))
  ?^  t  t
  =/  fs=(list feat)  (feats j)
  |-  ^-  (unit @t)
  ?~  fs  ~
  ?^  name.i.fs  name.i.fs
  $(fs t.fs)
::  +text-of: the title, and each feature's name, kind and note, one a
::  line, for search
++  text-of
  |=  j=json
  ^-  @t
  =/  fs=(list feat)  (feats j)
  =/  t  (title-of j)
  =|  out=(list @t)
  =?  out  ?=(^ t)  [u.t out]
  |-  ^-  @t
  ?~  fs  (rap 3 (join '\0a' (flop out)))
  =*  f  i.fs
  =/  w=(list @t)
    (murn ~[name.f kind.f note.f] same)
  $(fs t.fs, out (weld (flop w) out))
::
::  ── entry points ──────────────────────────────────────────────────
::
::  +gj-text: the words of a map page for search
++  gj-text
  |=  body=@t
  ^-  @t
  =/  r  (mule |.((bind (doc-of body) text-of)))
  ?.  ?=(%& -.r)  ''
  (fall p.r '')
::  +gj-title: the map's title, ~ when it has none
++  gj-title
  |=  body=@t
  ^-  (unit @t)
  =/  r  (mule |.((biff (doc-of body) title-of)))
  ?:(?=(%& -.r) p.r ~)
::  +gj-html: the map as safe HTML, or the note when refused
++  gj-html
  |=  body=@t
  ^-  tape
  html:(gj-all body)
::  +gj-all: the HTML, the text and the title from ONE parse
++  gj-all
  |=  body=@t
  ^-  [html=tape text=@t title=(unit @t)]
  =/  d  (mule |.((doc-of body)))
  ?.  ?=([%& ^] d)  [note-html '' ~]
  =*  j  u.p.d
  =/  h  (mule |.((html-of j)))
  =/  t  (mule |.((text-of j)))
  =/  l  (mule |.((title-of j)))
  :+  ?:(?=(%& -.h) p.h note-html)
    ?:(?=(%& -.t) p.t '')
  ?:(?=(%& -.l) p.l ~)
::
::  ── drawing ───────────────────────────────────────────────────────
::
::  A position is drawn in fixed point: degrees times 10^7, offset so
::  both are unsigned and y grows southwards. A number GeoJSON writes
::  with an exponent goes through @rd. Anything else unreadable is 0.
::
++  e7  10.000.000
::  +fix: a JSON number's text as a signed count of 10^-7 units: the
::  sign, the whole part, and up to seven places. The parts are read by
::  +digs, and found with +find, which is jetted. A number with an
::  exponent goes through @rd instead.
++  fix
  |=  t=@ta
  ^-  [neg=? v=@ud]
  =/  s=tape  (trip t)
  ?:  |(?=(^ (find "e" s)) ?=(^ (find "E" s)))  (fix-exp t)
  =/  neg=?  =('-' (end 3 t))
  =?  t  neg  `@ta`(rsh 3 t)
  =/  d=(unit @ud)  (find "." ?:(neg (slag 1 s) s))
  =/  w=@t  ?~(d t (end [3 u.d] t))
  =/  f=@t  ?~(d '' (end [3 7] (rsh [3 +(u.d)] t)))
  =/  fn=@ud  (met 3 f)
  [neg (add (mul e7 (digs w)) (mul (digs f) (pow 10 (sub 7 fn))))]
::  +digs: a run of digits as a number, 0 when it is anything else. It is
::  read by +slaw, which is jetted, and which refuses a zero in front. So
::  the digits are read with a 1 before them, and that 1 taken off again:
::  '0513' is 10.513 less 10.000.
++  digs
  |=  d=@t
  ^-  @ud
  =/  one=@ud  (pow 10 (met 3 d))
  (sub (fall (slaw %ui (cat 3 '0i1' d)) one) one)
::  +fix-exp: +fix for a number written with an exponent
++  fix-exp
  |=  t=@ta
  ^-  [neg=? v=@ud]
  =/  r  (mule |.((ne:dejs:format n+t)))
  ?.  ?=(%& -.r)  [| 0]
  =/  i  (toi:rd (mul:rd p.r .~1e7))
  ?~  i  [| 0]
  =/  o  (old:si u.i)
  [!-.o +.o]
::  +xy: a position as unsigned fixed point x (east) and y (south)
++  xy
  |=  p=json
  ^-  [x=@ud y=@ud]
  =/  nn=(unit [@ta @ta])  (two p)
  ?~  nn  [(mul 180 e7) (mul 90 e7)]
  =/  lo  (fix -.u.nn)
  =/  la  (fix +.u.nn)
  =/  lon=@ud  (min (mul 180 e7) v.lo)
  =/  lat=@ud  (min (mul 90 e7) v.la)
  :-  ?:(neg.lo (sub (mul 180 e7) lon) (add (mul 180 e7) lon))
  ?:(neg.la (add (mul 90 e7) lat) (sub (mul 90 e7) lat))
::  +two: a position's first two numbers, as written
++  two
  |=  p=json
  ^-  (unit [@ta @ta])
  ?.  ?=([%a *] p)  ~
  =/  l=(list json)  p.p
  ?~  l  ~
  ?~  t.l  ~
  =/  a=json  i.l
  =/  b=json  i.t.l
  ?.  ?=([%n *] a)  ~
  ?.  ?=([%n *] b)  ~
  `[p.a p.b]
::  +cos-table: cos of 0..90 degrees, in thousandths
++  cos-table
  ^~  ^-  (list @ud)
  :~  1.000  1.000  999  999  998  996  995  993  990  988
      985  982  978  974  970  966  961  956  951  946
      940  934  927  921  914  906  899  891  883  875
      866  857  848  839  829  819  809  799  788  777
      766  755  743  731  719  707  695  682  669  656
      643  629  616  602  588  574  559  545  530  515
      500  485  469  454  438  423  407  391  375  358
      342  326  309  292  276  259  242  225  208  191
      174  156  139  122  105  87  70  52  35  17  0
  ==
::  +html-of: the SVG and the table of a parsed body
++  html-of
  |=  j=json
  ^-  tape
  =/  fs=(list feat)  (feats j)
  =/  total=@ud  (lent fs)
  =/  npos=@ud  (roll (turn fs feat-size) add)
  =/  step=@ud  ?:((lte npos max-draw) 1 +((div npos max-draw)))
  ::  each feature's parts, its positions in fixed point, thinned
  =/  pts=(list drawn)
    %+  turn  fs
    |=  f=feat
    ^-  drawn
    :-  f
    %+  turn  parts.f
    |=  p=part
    ^-  [k=?(%pt %ln %pg) xs=(list [x=@ud y=@ud])]
    [k.p (turn (thin ps.p step) xy)]
  =/  all=(list [x=@ud y=@ud])  (zing (turn pts drawn-xys))
  %-  cats
  :~  "<div class=\"geojson\">"
      ?:(=(~ all) "" (svg-of pts all total))
      (table-of fs)
      ?:  (lte total max-show)  ""
      %-  cats
      :~  "<p class=\"geojson-note\">Showing the first "  (a-co:co max-show)
          " of "  (a-co:co total)  " features.</p>"
      ==
      "</div>"
  ==
+$  drawn  [f=feat ps=(list [k=?(%pt %ln %pg) xs=(list [x=@ud y=@ud])])]
::  +feat-size: how many positions a feature has
++  feat-size
  |=  f=feat
  ^-  @ud
  (roll (turn parts.f |=(p=part (lent ps.p))) add)
::  +drawn-xys: every position of a drawn feature
++  drawn-xys
  |=  d=drawn
  ^-  (list [x=@ud y=@ud])
  (zing (turn ps.d |=([* xs=(list [x=@ud y=@ud])] xs)))
::  +thin: every `n`th of a list, and always its last
++  thin
  |=  [l=(list json) n=@ud]
  ^-  (list json)
  ?:  (lte n 1)  l
  =/  i=@ud  0
  =|  out=(list json)
  |-  ^-  (list json)
  ?~  l  (flop out)
  ?~  t.l  (flop [i.l out])
  $(l t.l, i +(i), out ?:(=(0 (mod i n)) [i.l out] out))
::  +svg-of: the features drawn, fitted to their bounds
++  svg-of
  |=  $:  pts=(list drawn)
          all=(list [x=@ud y=@ud])
          total=@ud
      ==
  ^-  tape
  ?~  all  ""
  ::  the bounds, in one pass
  =/  b=[x0=@ud x1=@ud y0=@ud y1=@ud]
    =/  l=(list [x=@ud y=@ud])  t.all
    =/  a=[x0=@ud x1=@ud y0=@ud y1=@ud]  [x.i.all x.i.all y.i.all y.i.all]
    |-  ^+  a
    ?~  l  a
    $(l t.l, a [(min x0.a x.i.l) (max x1.a x.i.l) (min y0.a y.i.l) (max y1.a y.i.l)])
  =+  b
  ::  a span under a thousandth of a degree is widened about its middle,
  ::  so one point sits in the middle of the box
  =/  wx=@ud  (sub x1 x0)
  =/  wy=@ud  (sub y1 y0)
  =?  x0  (lth wx 10.000)
    =/  d  (div (sub 10.000 wx) 2)
    ?:((gte x0 d) (sub x0 d) 0)
  =?  y0  (lth wy 10.000)
    =/  d  (div (sub 10.000 wy) 2)
    ?:((gte y0 d) (sub y0 d) 0)
  ::  the middle latitude's cosine narrows east to west
  =/  mid=@ud  (div (add y0 y1) 2)
  =/  deg=@ud
    =/  s  (mul 90 e7)
    (div ?:((gte mid s) (sub mid s) (sub s mid)) e7)
  =/  c=@ud  (max 17 (snag (min 90 deg) cos-table))
  ::  at least a thousandth of a degree across, so one point has room
  =/  w=@ud  (mul c (max (sub x1 x0) 10.000))
  =/  h=@ud  (mul 1.000 (max (sub y1 y0) 10.000))
  =/  s=@ud  (max w h)
  =/  px  |=(x=@ud (div (mul (mul (sub x x0) c) 1.000) s))
  =/  py  |=(y=@ud (div (mul (mul (sub y y0) 1.000) 1.000) s))
  =/  vw=@ud  (div (mul w 1.000) s)
  =/  vh=@ud  (div (mul h 1.000) s)
  %-  cats
  :~
    "<svg class=\"geojson-map\" xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"-20 -20 "
    (a-co:co (add vw 40))  " "  (a-co:co (add vh 40))
    "\" role=\"img\" aria-label=\"A map of "  (a-co:co total)
    ?:(=(1 total) " feature" " features")
    "\"><rect x=\"-20\" y=\"-20\" width=\""  (a-co:co (add vw 40))
    "\" height=\""  (a-co:co (add vh 40))
    "\" fill=\"none\" stroke=\"currentColor\" stroke-opacity=\"0.2\"/>"
    %-  zing
    %+  turn  pts
    |=  [f=feat ps=(list [k=?(%pt %ln %pg) xs=(list [x=@ud y=@ud])])]
    ^-  tape
    =/  col=tape  ?~(color.f "#2563eb" (trip u.color.f))
    =/  tip=tape
      ?~  name.f  ""
      :(weld "<title>" (esc (trip u.name.f)) "</title>")
    %-  zing
    %+  turn  ps
    |=  [k=?(%pt %ln %pg) xs=(list [x=@ud y=@ud])]
    ^-  tape
    ?~  xs  ""
    ?:  ?=(%pt k)
      %-  zing
      %+  turn  `(list [x=@ud y=@ud])`xs
      |=  [x=@ud y=@ud]
      %-  cats
      :~
        "<circle cx=\""  (a-co:co (px x))  "\" cy=\""  (a-co:co (py y))
        "\" r=\"5\" fill=\""  col  "\">"  tip  "</circle>"
      ==
    =/  d=tape
      %-  zing
      %+  turn  `(list [x=@ud y=@ud])`xs
      |=  [x=@ud y=@ud]
      :(weld " " (a-co:co (px x)) "," (a-co:co (py y)))
    %-  cats
    :~
      "<path d=\"M"  d  ?:(?=(%pg k) " Z" "")
      "\" stroke=\""  col  "\" stroke-width=\"2\" fill=\""
      ?:(?=(%pg k) col "none")
      "\" fill-opacity=\"0.2\" vector-effect=\"non-scaling-stroke\">"
      tip  "</path>"
    ==
    "</svg>"
  ==
::  +table-of: a row for each of the first +max-show features
++  table-of
  |=  fs=(list feat)
  ^-  tape
  ?:  =(~ fs)  "<p class=\"geojson-note\">This map has no features yet.</p>"
  %-  cats
  :~
    "<table class=\"geojson-table\"><thead><tr><th>Name</th><th>Kind</th>"
    "<th>Time</th><th>Where</th></tr></thead><tbody>"
    %-  zing
    %+  turn  (scag max-show fs)
    |=  f=feat
    ^-  tape
    =/  cel  |=(u=(unit @t) `tape`:(weld "<td>" ?~(u "" (esc (trip u.u))) "</td>"))
    %-  cats
    :~
      "<tr>"  (cel name.f)
      (cel ?^(kind.f kind.f ?:(=('' gtype.f) ~ `gtype.f)))
      (cel time.f)  (cel (where f))  "</tr>"
    ==
    "</tbody></table>"
  ==
::  +where: a feature's first position as "lat, lon", as written
++  where
  |=  f=feat
  ^-  (unit @t)
  ?~  parts.f  ~
  =/  ps  ps.i.parts.f
  ?~  ps  ~
  =/  nn=(unit [@ta @ta])  (two i.ps)
  ?~  nn  ~
  `(rap 3 ~[(end [3 12] +.u.nn) ', ' (end [3 12] -.u.nn)])
::  +cats: tapes joined
++  cats  |=(l=(list tape) ^-(tape (zing l)))
::  +esc: HTML escaping
++  esc
  |=  t=tape
  ^-  tape
  =|  acc=tape
  |-  ^-  tape
  ?~  t  (flop acc)
  =*  c  i.t
  ?:  =('&' c)  $(t t.t, acc (weld ";pma&" acc))
  ?:  =('<' c)  $(t t.t, acc (weld ";tl&" acc))
  ?:  =('>' c)  $(t t.t, acc (weld ";tg&" acc))
  ?:  =('"' c)  $(t t.t, acc (weld ";touq&" acc))
  ?:  =('\'' c)  $(t t.t, acc (weld ";93#&" acc))
  $(t t.t, acc [c acc])
--
