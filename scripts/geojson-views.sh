#!/usr/bin/env bash
# geojson-views.sh: a map page in every view a markdown page has, its
# check on save and an agent key's writes.
# Makes mapviews/trip on a FAKE ship and checks the save refusals, the
# editor's open (page-source?render=1, which carries no render: map.js
# draws the page), the /x view, the clearweb view (/c), the urb://
# reader, page-search, the published vault copy and a new revision.
# Deletes its pages and its key at the end.
#
# Usage:  LATTICE_URL=http://localhost:8120 LATTICE_COOKIE=/tmp/grp-probe/cookie \
#           scripts/geojson-views.sh
#
# The vault copy and the reader are what a peer receives: a published
# map is its rendered HTML under %html, an SVG and a table, with no tile
# and no GeoJSON.
set -uo pipefail
URL="${LATTICE_URL:?LATTICE_URL}"; URL="${URL%/}"; A="$URL/apps/lattice"
CK="Cookie: $(cat "${LATTICE_COOKIE:?LATTICE_COOKIE}")"
OR="Origin: $URL"
fails=0
ok()   { echo "ok    $1"; }
fail() { echo "FAIL  $1${2:+: $2}"; fails=$((fails+1)); }
is()   { if [ "$2" = "$3" ]; then ok "$1"; else fail "$1" "want [$2] got [$3]"; fi; }
has()  { if grep -qF -- "$2" <<<"$3"; then ok "$1"; else fail "$1" "no [$2]"; fi; }
hasnt(){ if grep -qF -- "$2" <<<"$3"; then fail "$1" "found [$2]"; else ok "$1"; fi; }
get()  { curl -s -m 120 -H "$CK" "$@"; }
code() { curl -s -m 120 -o /dev/null -w '%{http_code}' -H "$CK" -H "$OR" "$@"; }
SHIP=$(curl -s -m 30 -H "$CK" "$URL/~/host")
[ -n "$SHIP" ] || { echo "FAIL  the ship answers /~/host"; exit 1; }
INST=/apps/shell.shell/desks/lattice.desk/desk/data/lattice.lattice_app
T="${TMPDIR:-/tmp}/geojson-views-$$"; mkdir -p "$T"
KEYID=""

feat() { # name lon lat [kind]
  printf '{"type":"Feature","geometry":{"type":"Point","coordinates":[%s,%s]},"properties":{"name":"%s","kind":"%s"}}' "$2" "$3" "$1" "${4:-place}"
}
coll() { # title feature...
  local t=$1; shift
  printf '{"type":"FeatureCollection","lattice":{"title":"%s"},"features":[\n' "$t"
  local first=1
  for f in "$@"; do [ $first = 1 ] || printf ',\n'; printf '%s' "$f"; first=0; done
  printf '\n]}\n'
}
coll "Alpine trip" "$(feat Matterhornhut 7.6586 45.9764)" \
  '{"type":"Feature","geometry":{"type":"LineString","coordinates":[[7.65,45.97],[7.66,45.98],[7.67,45.99]]},"properties":{"name":"Hornli ridge","kind":"route","color":"#ff8800"}}' \
  >"$T/trip.geojson"
coll "Hostile" "$(feat '<script>PWNED()</script>' 1 2)" \
  '{"type":"Feature","geometry":{"type":"Point","coordinates":[3,4]},"properties":{"name":"x\" onload=\"PWNED()","kind":"<img src=x onerror=PWNED()>","color":"#f00\"/><script>PWNED()</script>"}}' \
  >"$T/hostile.geojson"

cleanup() {
  for p in mapviews/trip mapviews/hostile mapviews/bad mapviews/agent mapviews/note mapviews; do
    code -X POST "$A/page-del?name=$p" >/dev/null
  done
  [ -n "$KEYID" ] && code -X POST "$A/key-revoke?id=$KEYID" >/dev/null
  rm -rf "$T"
}
trap cleanup EXIT
for p in mapviews/trip mapviews/hostile mapviews/bad mapviews/agent mapviews/note; do code -X POST "$A/page-del?name=$p" >/dev/null; done

save() { code -X POST "$A/page-save?name=$1&type=$2&new=1" --data-binary "@$3"; }
said() { curl -s -m 120 -H "$CK" -H "$OR" -X POST "$A/page-save?name=$1&type=geojson" --data-binary "$2" | jq -r .error; }

# ── the check on save ────────────────────────────────────────────────
is "make a geojson page" 200 "$(save mapviews/trip geojson "$T/trip.geojson")"
is "not JSON is refused" "that map is not valid JSON" "$(said mapviews/bad 'nope')"
is "a Feature alone is refused" "a map page must be a GeoJSON FeatureCollection" "$(said mapviews/bad '{"type":"Feature"}')"
is "a short line is refused" "a feature has a geometry GeoJSON does not define" \
  "$(said mapviews/bad '{"type":"FeatureCollection","features":[{"type":"Feature","geometry":{"type":"LineString","coordinates":[[1,2]]},"properties":{}}]}')"
python3 -c 'n=60000;print("{\"type\":\"FeatureCollection\",\"features\":[],\"x\":"+"["*n+"]"*n+"}")' >"$T/deep.json"
is "a nesting bomb is refused" "that map nests deeper than GeoJSON does" \
  "$(curl -s -m 120 -H "$CK" -H "$OR" -X POST "$A/page-save?name=mapviews/bad&type=geojson" --data-binary "@$T/deep.json" | jq -r .error)"
is "the refused page was never made" 404 "$(curl -s -m 60 -o /dev/null -w '%{http_code}' -H "$CK" "$A/page-source?name=mapviews/bad")"
b=$(curl -s -m 120 -H "$CK" -H "$OR" -H 'content-type: application/json' -X POST "$A/page-save-batch" \
  --data-binary '[{"name":"mapviews/bad","type":"geojson","body":"[1]"}]' | jq -r .error)
is "a batch with a bad map is refused" "mapviews/bad: a map page must be a GeoJSON FeatureCollection" "$b"

# ── the editor's open ────────────────────────────────────────────────
src=$(get "$A/page-source?name=mapviews/trip&render=1")
is "page-source kind" geojson "$(jq -r .kind <<<"$src")"
is "page-source body is the file" "$(sha1sum <"$T/trip.geojson" | cut -d' ' -f1)" \
  "$(jq -j .body <<<"$src" | sha1sum | cut -d' ' -f1)"
is "render=1 carries no render (map.js draws it)" "false" "$(jq 'has("html")' <<<"$src")"

# ── the /x view ──────────────────────────────────────────────────────
x=$(get "$A/x/$SHIP$INST/page/mapviews/trip/?embed=1")
has   "/x embed is the map render" '<div class="geojson"><svg class="geojson-map"' "$x"
has   "/x embed lists a feature" "<td>Matterhornhut</td>" "$x"
has   "/x embed draws the route" 'stroke="#ff8800"' "$x"
hasnt "/x embed shows no GeoJSON" '"FeatureCollection"' "$x"
x=$(get "$A/x/$SHIP$INST/page/mapviews/trip/")
has   "/x title is the map's title" "<title>Alpine trip" "$x"

# ── search: names, not JSON ──────────────────────────────────────────
s=$(get "$A/page-search?q=matterhornhut")
has   "page-search finds a feature name" '"mapviews/trip"' "$s"
s=$(get "$A/page-search?q=coordinates")
hasnt "page-search does not find a JSON key" '"mapviews/trip"' "$s"

# ── clearweb and the published copy ──────────────────────────────────
is "share clearweb" 200 "$(code -X POST "$A/page-share?name=mapviews/trip&mode=clearweb")"
c=""
for _ in $(seq 1 30); do c=$(get "$A/c/mapviews/trip"); grep -qF Matterhornhut <<<"$c" && break; sleep 1; done
has   "/c shows the map" 'class="geojson-map"' "$c"
hasnt "/c shows no GeoJSON" '"FeatureCollection"' "$c"
vault() { get -G "$A/fetch" --data-urlencode "url=urb://$SHIP/mapviews/trip" | jq -r .body; }
v=""
for _ in $(seq 1 30); do v=$(vault); grep -qF Matterhornhut <<<"$v" && break; sleep 1; done
has   "the vault copy is the render" 'class="geojson"' "$v"
hasnt "the vault copy holds no GeoJSON" '"FeatureCollection"' "$v"
r=$(get -G "$A" --data-urlencode "url=urb://$SHIP/mapviews/trip")
has   "reader shows the map" "Matterhornhut" "$r"
has   "reader frames it (the %html branch)" "<iframe" "$r"

# ── a new revision never serves the old render ───────────────────────
sed 's/Matterhornhut/Solvayhut/' "$T/trip.geojson" >"$T/edit.geojson"
is "save a new revision" 200 "$(code -X POST "$A/page-save?name=mapviews/trip&type=geojson" --data-binary "@$T/edit.geojson")"
# the page runs after the save, so /x shows it a moment later
x=""
for _ in $(seq 1 30); do x=$(get "$A/x/$SHIP$INST/page/mapviews/trip/?embed=1"); grep -qF Solvayhut <<<"$x" && break; sleep 1; done
has   "/x shows the new revision" "<td>Solvayhut</td>" "$x"
hasnt "/x drops the old name" "Matterhornhut" "$x"
v=""
for _ in $(seq 1 30); do v=$(vault); grep -qF Solvayhut <<<"$v" && break; sleep 1; done
has "the republished copy is the new render" "Solvayhut" "$v"

# ── a hostile map renders as text ────────────────────────────────────
is "make a hostile map" 200 "$(save mapviews/hostile geojson "$T/hostile.geojson")"
h=$(get "$A/x/$SHIP$INST/page/mapviews/hostile/?embed=1")
f=${h#*<div class=\"geojson\">}; f=${f%%</table>*}
has   "a hostile name shows as text" "&lt;script&gt;PWNED()&lt;/script&gt;" "$f"
hasnt "no script from the page" "<script" "$f"
hasnt "no img element" "<img" "$f"
hasnt "no handler from a name" ' onload="' "$f"
hasnt "a hostile colour is not used" 'PWNED()</script>"' "$f"

# ── agent keys may write maps, and only as maps ──────────────────────
mint=$(curl -s -m 60 -H "$CK" -H "$OR" -H 'content-type: application/json' -X POST "$A/key-mint" \
  --data-binary '{"name":"geojson-views","by":"agent","scope":{"memory":"none","pages":{"all":"write"},"web":{"off":null},"sensitive":false,"skills":"none"}}')
TOK=$(jq -r .token <<<"$mint"); KEYID=$(jq -r .key.id <<<"$mint")
KH="Authorization: Bearer $TOK"
kcode() { curl -s -m 120 -o /dev/null -w '%{http_code}' -H "$KH" "$@"; }
is "a key saves a map" 200 "$(kcode -X POST "$A/page-save?name=mapviews/agent&type=geojson" --data-binary "@$T/trip.geojson")"
is "a key's bad map is refused" 400 "$(kcode -X POST "$A/page-save?name=mapviews/agent&type=geojson" --data-binary '[1]')"
is "a key cannot save markdown over a map" 403 "$(kcode -X POST "$A/page-save?name=mapviews/agent&type=md" --data-binary 'hi')"
is "a key saves a map in a batch" 200 "$(kcode -X POST -H 'content-type: application/json' "$A/page-save-batch" \
  --data-binary "$(jq -n --rawfile b "$T/edit.geojson" '[{name:"mapviews/agent",type:"geojson",body:$b}]')")"
is "a key cannot change a map in a batch" 403 "$(kcode -X POST -H 'content-type: application/json' "$A/page-save-batch" \
  --data-binary '[{"name":"mapviews/agent","type":"text","body":"x"}]')"

echo "geojson-views: $fails failed"
exit $((fails > 0))
