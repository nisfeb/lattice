::  Unit tests for /lib/lattice-geojson: a map page's check on save, its
::  safe SVG and table, its search text and its title. A normal map,
::  each geometry, the view member, hostile names and colours, the
::  bombs (depth, size, counts) and the caps on what a render draws.
::
/+  *test, gj=lattice-geojson
|%
++  has  |=([n=tape h=tape] ^-(? ?=(^ (find n h))))
++  yes  |=(c=? (expect-eq !>(&) !>(c)))
++  no   |=(c=? (expect-eq !>(|) !>(c)))
++  ok   |=(b=@t (expect-eq !>(`(unit @t)`~) !>((gj-check:gj b))))
++  bad  |=(b=@t (yes ?=(^ (gj-check:gj b))))
++  hits
  |=  [n=tape h=tape]
  ^-  @ud
  =|  c=@ud
  |-  ^-  @ud
  =/  i  (find n h)
  ?~  i  c
  $(h (slag +(u.i) h), c +(c))
::  +fc: a collection of these features, one a line, as lattice writes it
++  fc
  |=  fs=(list @t)
  ^-  @t
  %+  rap  3
  :~  '{"type":"FeatureCollection","lattice":{},"features":[\0a'
      (rap 3 (join ',\0a' fs))
      '\0a]}\0a'
  ==
::  +pt: a point feature with this name
++  pt
  |=  [nm=@t lon=@t lat=@t]
  ^-  @t
  %+  rap  3
  :~  '{"type":"Feature","geometry":{"type":"Point","coordinates":['
      lon  ','  lat
      ']},"properties":{"name":"'  nm  '"}}'
  ==
++  line
  '{"type":"Feature","geometry":{"type":"LineString","coordinates":[[-73.9,40.7],[-73.8,40.8]]},"properties":{"name":"route","kind":"route"}}'
++  poly
  '{"type":"Feature","geometry":{"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,0]]]},"properties":{"name":"zone","color":"#ff0000"}}'
::
::  ── the check on save ───────────────────────────────────────────
::
++  test-check-good
  ;:  weld
    (ok (fc ~))
    (ok (fc ~[(pt 'a' '1' '2')]))
    (ok (fc ~[(pt 'a' '-73.9857123' '40.7484321') line poly]))
    (ok '{"type":"FeatureCollection","features":[]}')
    (ok '{"type":"FeatureCollection","features":[{"type":"Feature","geometry":null,"properties":null}]}')
    (ok '{"type":"FeatureCollection","features":[{"type":"Feature","geometry":{"type":"MultiPoint","coordinates":[[1,2],[3,4,5]]},"properties":{}}]}')
    (ok '{"type":"FeatureCollection","features":[{"type":"Feature","geometry":{"type":"MultiPolygon","coordinates":[[[[0,0],[1,0],[1,1],[0,0]]]]},"properties":{}}]}')
    (ok '{"type":"FeatureCollection","features":[{"type":"Feature","geometry":{"type":"GeometryCollection","geometries":[{"type":"Point","coordinates":[1,2]}]},"properties":{}}]}')
    (ok '{"type":"FeatureCollection","lattice":{"title":"t","layers":["maps/a"]},"features":[],"other":1}')
    (ok '{"type":"FeatureCollection","features":[{"type":"Feature","id":7,"geometry":{"type":"Point","coordinates":[1e1,-2.5E-3]},"properties":{"deep":{"a":[1,{"b":2}]}}}]}')
  ==
++  test-check-refuses
  ;:  weld
    (bad '')
    (bad 'not json')
    (bad '[]')
    (bad '{"type":"Feature","geometry":null,"properties":{}}')
    (bad '{"type":"FeatureCollection"}')
    (bad '{"type":"FeatureCollection","features":{}}')
    (bad '{"type":"FeatureCollection","features":[1]}')
    (bad '{"type":"FeatureCollection","features":[{"type":"Point","coordinates":[1,2]}]}')
    (bad '{"type":"FeatureCollection","features":[{"type":"Feature","geometry":{"type":"Point","coordinates":[1]},"properties":{}}]}')
    (bad '{"type":"FeatureCollection","features":[{"type":"Feature","geometry":{"type":"Point","coordinates":["1","2"]},"properties":{}}]}')
    (bad '{"type":"FeatureCollection","features":[{"type":"Feature","geometry":{"type":"LineString","coordinates":[[1,2]]},"properties":{}}]}')
    (bad '{"type":"FeatureCollection","features":[{"type":"Feature","geometry":{"type":"Polygon","coordinates":[[[0,0],[1,0],[0,0]]]},"properties":{}}]}')
    (bad '{"type":"FeatureCollection","features":[{"type":"Feature","geometry":{"type":"Circle","coordinates":[1,2]},"properties":{}}]}')
    (bad '{"type":"FeatureCollection","features":[{"type":"Feature","geometry":null,"properties":[1]}]}')
    (bad '{"type":"FeatureCollection","lattice":[],"features":[]}')
    (bad '{"type":"FeatureCollection","lattice":{"layers":[1]},"features":[]}')
    ::  a collection inside a collection is not a geometry
    (bad '{"type":"FeatureCollection","features":[{"type":"Feature","geometry":{"type":"GeometryCollection","geometries":[{"type":"GeometryCollection","geometries":[]}]},"properties":{}}]}')
  ==
::  a refusal says why, in words
++  test-check-says-why
  ;:  weld
    (expect-eq !>(`(unit @t)``'that map is not valid JSON') !>((gj-check:gj '{')))
    %+  expect-eq  !>(`(unit @t)``'a map page must be a GeoJSON FeatureCollection')
    !>((gj-check:gj '{"type":"Feature"}'))
  ==
::
::  ── bombs ───────────────────────────────────────────────────────
::
::  deep nesting is refused by the scan, before the parse
++  test-depth-bomb
  =/  n=@ud  100.000
  =/  b=@t  (rap 3 (weld (reap n '[') (reap n ']')))
  =/  w=@t  (rap 3 ~['{"type":"FeatureCollection","features":[],"x":' b '}'])
  ;:  weld
    (expect-eq !>(`(unit @t)``'that map nests deeper than GeoJSON does') !>((gj-check:gj w)))
    (no (depth-ok:gj w))
  ==
::  brackets in strings do not count, and an escaped quote stays in one
++  test-depth-strings
  =/  s=@t  (rap 3 (reap 20.000 '['))
  =/  w=@t  (rap 3 ~['{"type":"FeatureCollection","features":[],"x":"\\"' s '"}'])
  (ok w)
::  just under the depth cap passes, just over it does not
++  test-depth-edge
  =/  pad=@t  (rap 3 (reap 9.000 '1,'))
  =/  mk
    |=  d=@ud
    ^-  @t
    %+  rap  3
    :~  '{"type":"FeatureCollection","features":[],"x":['  pad
        (rap 3 (reap d '['))  (rap 3 (reap d ']'))  ']}'
    ==
  ::  the collection and x are two levels already
  ;:  weld
    (yes (depth-ok:gj (mk 62)))
    (no (depth-ok:gj (mk 63)))
  ==
++  test-size-cap
  ::  only its size is read: a 4 MB atom of nulls and one byte
  =/  big=@t  (lsh [3 (bex 22)] '{')
  (expect-eq !>(`(unit @t)``'that map is over 4 MB') !>((gj-check:gj big)))
++  test-feature-cap
  =/  f=@t  '{"type":"Feature","geometry":null,"properties":null}'
  ;:  weld
    (bad (fc (reap 20.001 f)))
    (ok (fc (reap 2.000 f)))
  ==
++  test-position-cap
  =/  ps=@t  (rap 3 (join ',' (reap 250.001 '[1,2]')))
  =/  f=@t  (rap 3 ~['{"type":"Feature","geometry":{"type":"MultiPoint","coordinates":[' ps ']},"properties":{}}'])
  (expect-eq !>(`(unit @t)``'that map has over 500,000 positions') !>((gj-check:gj (fc ~[f f]))))
::
::  ── the render ──────────────────────────────────────────────────
::
++  test-html-shape
  =/  h=tape  (gj-html:gj (fc ~[(pt 'Home' '-73.98' '40.74') line poly]))
  ;:  weld
    (yes (has "<div class=\"geojson\">" h))
    (yes (has "<svg class=\"geojson-map\"" h))
    (expect-eq !>(1) !>((hits "<circle" h)))
    (expect-eq !>(2) !>((hits "<path" h)))
    (yes (has " Z\"" h))
    (yes (has "fill=\"#ff0000\"" h))
    (yes (has "<td>Home</td>" h))
    (yes (has "<td>route</td>" h))
    (yes (has "<td>Polygon</td>" h))
    (yes (has "<td>40.74, -73.98</td>" h))
    (expect-eq !>(4) !>((hits "<tr>" h)))
  ==
::  every output starts as +html-pres says
++  test-html-pres
  =/  pre  |=(h=tape (lien html-pres:gj |=(p=@t =(p (end [3 (met 3 p)] (crip h))))))
  ;:  weld
    (yes (pre (gj-html:gj (fc ~[line]))))
    (yes (pre (gj-html:gj (fc ~))))
    (yes (pre (gj-html:gj 'nope')))
    (expect-eq !>(note-html:gj) !>((gj-html:gj 'nope')))
  ==
++  test-html-empty
  =/  h=tape  (gj-html:gj (fc ~))
  ;:  weld
    (no (has "<svg" h))
    (yes (has "no features yet" h))
  ==
::  a name, a kind and a time are escaped everywhere they show
++  test-html-escapes
  =/  f=@t  '{"type":"Feature","geometry":{"type":"Point","coordinates":[1,2]},"properties":{"name":"<script>alert(1)</script>","kind":"\\"><img src=x onerror=alert(1)>","time":"<b>","note":"<iframe>"}}'
  =/  h=tape  (gj-html:gj (fc ~[f]))
  ;:  weld
    (no (has "<script" h))
    (no (has "<img" h))
    (no (has "<b>" h))
    (no (has "<iframe" h))
    (yes (has "&lt;script&gt;" h))
    (yes (has "&quot;&gt;&lt;img" h))
  ==
::  a colour that is not a hex is not used, so it cannot break out
++  test-html-colour
  =/  mk
    |=  c=@t
    (gj-html:gj (fc ~[(rap 3 ~['{"type":"Feature","geometry":{"type":"Point","coordinates":[1,2]},"properties":{"color":"' c '"}}'])]))
  ;:  weld
    (yes (has "fill=\"#abc\"" (mk '#abc')))
    (yes (has "fill=\"#A0b1C2\"" (mk '#A0b1C2')))
    (yes (has "fill=\"#2563eb\"" (mk 'red')))
    (yes (has "fill=\"#2563eb\"" (mk '#abcd')))
    (yes (has "fill=\"#2563eb\"" (mk '#ab\\"><x')))
    (no (has "><x" (mk '#ab\\"><x')))
  ==
::  the table stops at the first 2,000 features, and says so
++  test-html-show-cap
  =/  h=tape  (gj-html:gj (fc (reap 2.001 (pt 'p' '1' '2'))))
  ;:  weld
    (expect-eq !>(2.001) !>((hits "<tr>" h)))
    (yes (has "Showing the first 2000 of 2001 features." h))
  ==
::  a long track is thinned to the draw cap, keeping its ends
++  test-html-thin
  =/  ps=@t  (rap 3 (join ',' (reap 50.000 '[1.5,2.5]')))
  =/  f=@t  (rap 3 ~['{"type":"Feature","geometry":{"type":"LineString","coordinates":[' ps ',[3,4]]},"properties":{}}'])
  =/  h=tape  (gj-html:gj (fc ~[f]))
  ;:  weld
    (expect-eq !>(1) !>((hits "<path" h)))
    (yes ?&((lth (hits "," h) 5.100) (gth (hits "," h) 4.000)))
  ==
::  points far apart fit the view box, and one point alone has room
++  test-html-fit
  =/  one=tape  (gj-html:gj (fc ~[(pt 'a' '10' '20')]))
  =/  two=tape  (gj-html:gj (fc ~[(pt 'a' '-170' '-80') (pt 'b' '170' '80')]))
  ;:  weld
    ::  at 20 north the box is cos 20 wide, and the point in its middle
    (yes (has "cx=\"470\" cy=\"500\"" one))
    (yes (has "cx=\"0\" cy=\"470\"" two))
    (yes (has "cx=\"1000\" cy=\"0\"" two))
    (yes (has "aria-label=\"A map of 1 feature\"" one))
  ==
::
::  ── text and title ──────────────────────────────────────────────
::
++  test-title
  ;:  weld
    (expect-eq !>(`(unit @t)``'Trip') !>((gj-title:gj '{"type":"FeatureCollection","lattice":{"title":"Trip"},"features":[]}')))
    (expect-eq !>(`(unit @t)``'route') !>((gj-title:gj (fc ~[(pt '' '1' '2') line poly]))))
    (expect-eq !>(`(unit @t)``'zone') !>((gj-title:gj (fc ~[poly]))))
    (expect-eq !>(`(unit @t)`~) !>((gj-title:gj (fc ~))))
    (expect-eq !>(`(unit @t)`~) !>((gj-title:gj 'nope')))
  ==
++  test-text
  =/  f=@t  '{"type":"Feature","geometry":null,"properties":{"name":"Cafe","kind":"place","note":"good **coffee**"}}'
  =/  t=@t  (gj-text:gj (rap 3 ~['{"type":"FeatureCollection","lattice":{"title":"Trip"},"features":[' f ']}']))
  ;:  weld
    (expect-eq !>('Trip\0aCafe\0aplace\0agood **coffee**') !>(t))
    (expect-eq !>('') !>((gj-text:gj 'nope')))
  ==
::  +gj-all is the three entry points from one parse
++  test-all
  =/  b=@t  (fc ~[(pt 'a' '1' '2') line])
  =/  a  (gj-all:gj b)
  ;:  weld
    (expect-eq !>((gj-html:gj b)) !>(html.a))
    (expect-eq !>((gj-text:gj b)) !>(text.a))
    (expect-eq !>((gj-title:gj b)) !>(title.a))
  ==
::  numbers as GeoJSON may write them
++  test-fix
  ;:  weld
    (expect-eq !>([| 405.000.000]) !>((fix:gj '40.5')))
    (expect-eq !>([& 739.857.123]) !>((fix:gj '-73.9857123')))
    (expect-eq !>([| 12.345.678]) !>((fix:gj '1.23456789')))
    (expect-eq !>([| 100.000.000]) !>((fix:gj '1e1')))
    (expect-eq !>([& 25.000]) !>((fix:gj '-2.5E-3')))
    (expect-eq !>([| 0]) !>((fix:gj '0')))
  ==
::  a position may carry a height and a measure, and no more
++  test-check-position-length
  =/  mk
    |=  c=@t
    (rap 3 ~['{"type":"FeatureCollection","features":[{"type":"Feature","geometry":{"type":"Point","coordinates":[' c ']},"properties":{}}]}'])
  ;:  weld
    (ok (mk '1,2'))
    (ok (mk '1,2,3'))
    (ok (mk '1,2,3,4'))
    (bad (mk '1,2,3,4,5'))
  ==
::  every hex digit is a hex digit, at both ends of each range
++  test-html-colour-digits
  =/  mk
    |=  c=@t
    (gj-html:gj (fc ~[(rap 3 ~['{"type":"Feature","geometry":{"type":"Point","coordinates":[1,2]},"properties":{"color":"' c '"}}'])]))
  ;:  weld
    (yes (has "fill=\"#09f\"" (mk '#09f')))
    (yes (has "fill=\"#0AF\"" (mk '#0AF')))
    (yes (has "fill=\"#2563eb\"" (mk '#0g0')))
    (yes (has "fill=\"#2563eb\"" (mk '#0G0')))
    ::  one byte past each end of each range
    (yes (has "fill=\"#2563eb\"" (mk '#!!!')))
    (yes (has "fill=\"#2563eb\"" (mk '#:::')))
    (yes (has "fill=\"#2563eb\"" (mk '#@@@')))
    (yes (has "fill=\"#2563eb\"" (mk '#ZZZ')))
    (yes (has "fill=\"#2563eb\"" (mk '#[[[')))
    (yes (has "fill=\"#2563eb\"" (mk '#zzz')))
  ==
::  exactly the draw cap is drawn whole, and exactly the list cap lists
::  every feature with no note
++  test-html-cap-edges
  =/  ps=@t  (rap 3 (join ',' (reap 5.000 '[1.5,2.5]')))
  =/  f=@t  (rap 3 ~['{"type":"Feature","geometry":{"type":"LineString","coordinates":[' ps ']},"properties":{}}'])
  =/  h=tape  (gj-html:gj (fc ~[f]))
  =/  l=tape  (gj-html:gj (fc (reap 2.000 (pt 'p' '1' '2'))))
  ;:  weld
    (expect-eq !>(5.001) !>((hits "," h)))
    (no (has "Showing the first" l))
  ==
::  the caps are inclusive: exactly at each one passes that check
++  test-cap-edges
  =/  f=@t  '{"type":"Feature","geometry":null,"properties":null}'
  ::  exactly 4 MB is not over the size cap (and is no JSON either)
  =/  four=@t  (lsh [3 (dec (bex 22))] '{')
  ;:  weld
    (ok (fc (reap 20.000 f)))
    (expect-eq !>(`(unit @t)``'that map is not valid JSON') !>((gj-check:gj four)))
  ==
--
