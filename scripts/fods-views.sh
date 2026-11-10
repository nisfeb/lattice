#!/usr/bin/env bash
# fods-views.sh: a spreadsheet page in every view a markdown page has.
# Makes sheetviews/calc from a corpus file on a FAKE ship and checks the
# editor's open (page-source?render=1), the /x view, the clearweb view
# (/c), the urb:// reader, page-search, the published vault copy and a
# new revision. Deletes its pages at the end.
#
# Usage:  LATTICE_URL=http://localhost:8120 LATTICE_COOKIE=/tmp/grp-probe/cookie \
#           scripts/fods-views.sh
# Env:    B_URL and B_COOKIE: a second fake ship, which reads the page
#         over urb:// as a peer (it must already know A, a |hi each way),
#         and then two shared hostile spreadsheets: each must arrive as a
#         sandboxed frame holding an inert render.
#
# The vault copy and the reader are what a peer receives: a published
# spreadsheet is its rendered HTML under %html, cached values only. No
# formula and no flat ODS leaves the ship.
set -uo pipefail
URL="${LATTICE_URL:?LATTICE_URL}"; URL="${URL%/}"; A="$URL/apps/lattice"
CK="Cookie: $(cat "${LATTICE_COOKIE:?LATTICE_COOKIE}")"
HERE="$(cd "$(dirname "$0")" && pwd)"; CORPUS="$HERE/../tests/sheet/corpus"
fails=0
ok()   { echo "ok    $1"; }
fail() { echo "FAIL  $1${2:+: $2}"; fails=$((fails+1)); }
is()   { if [ "$2" = "$3" ]; then ok "$1"; else fail "$1" "want [$2] got [$3]"; fi; }
has()  { if grep -qF -- "$2" <<<"$3"; then ok "$1"; else fail "$1" "no [$2]"; fi; }
hasnt(){ if grep -qF -- "$2" <<<"$3"; then fail "$1" "found [$2]"; else ok "$1"; fi; }
get()  { curl -s -m 120 -H "$CK" "$@"; }
code() { curl -s -m 120 -o /dev/null -w '%{http_code}' -H "$CK" "$@"; }
SHIP=$(curl -s -m 30 -H "$CK" "$URL/~/host")
[ -n "$SHIP" ] || { echo "FAIL  the ship answers /~/host"; exit 1; }
INST=/apps/shell.shell/desks/lattice.desk/desk/data/lattice.lattice_app
T="${TMPDIR:-/tmp}/fods-views-$$"; mkdir -p "$T"
# two hostile spreadsheets: markup in a sheet name and in cells, and a
# link, a formula and an external reference that must not come through
sed -e 's/table:name="Texte"/table:name="\&lt;img src=x onerror=PWNED()\&gt;"/' \
    -e 's|<text:p>emoji</text:p>|<text:p>\&lt;script\&gt;PWNED()\&lt;/script\&gt; Escaped markup in text</text:p>|' \
    "$CORPUS/09-i18n.fods" >"$T/h-markup.fods"
sed -e 's|https://example.com/a?b=1&amp;c=2|javascript:PWNED()|' \
    -e 's|<text:p>rtl</text:p>|<text:p>=HYPERLINK("http://evil.example/")</text:p>|' \
    "$CORPUS/09-i18n.fods" >"$T/h-links.fods"

cleanup() {
  for p in sheetviews/calc sheetviews/h-markup sheetviews/h-links sheetviews; do
    code -X POST "$A/page-del?name=$p" >/dev/null
  done
  rm -rf "$T"
}
trap cleanup EXIT
for p in sheetviews/calc sheetviews/h-markup sheetviews/h-links; do code -X POST "$A/page-del?name=$p" >/dev/null; done

save() { code -X POST "$A/page-save?name=$1&type=$2&new=1" --data-binary "@$3"; }

# 02-formulas: one sheet, "Calc", with the words "precedence" and
# "sumproduct" in cells and =[.A2]+[.B2] giving 5
is "make a fods page" 200 "$(save sheetviews/calc fods "$CORPUS/02-formulas.fods")"
WORD="precedence"

# the editor's open
src=$(get "$A/page-source?name=sheetviews/calc&render=1")
is "page-source kind" fods "$(jq -r .kind <<<"$src")"
is "page-source body is the file" "$(sha1sum <"$CORPUS/02-formulas.fods" | cut -d' ' -f1)" \
  "$(jq -j .body <<<"$src" | sha1sum | cut -d' ' -f1)"
html=$(jq -r .html <<<"$src")
has   "render=1 shows a cell" "$WORD" "$html"
has   "render=1 is the fods table" '<div class="fods"><h3>Calc</h3><table>' "$html"
hasnt "render=1 shows no office: tags" "office:" "$html"
hasnt "render=1 shows no formula" "of:=" "$html"
hasnt "render=1 shows no style names" "style-name" "$html"

# the /x view, bare and standalone
x=$(get "$A/x/$SHIP$INST/page/sheetviews/calc/?embed=1")
has   "/x embed shows a cell" "$WORD" "$x"
hasnt "/x embed shows no office: tags" "office:" "$x"
x=$(get "$A/x/$SHIP$INST/page/sheetviews/calc/")
has   "/x title is the sheet's name" "<title>Calc" "$x"

# search: cell text only
s=$(get "$A/page-search?q=$WORD")
has   "page-search finds a cell word" '"sheetviews/calc"' "$s"
s=$(get "$A/page-search?q=calcext")
hasnt "page-search does not find calcext" '"sheetviews/calc"' "$s"
s=$(get "$A/page-search?q=office")
hasnt "page-search does not find office" '"sheetviews/calc"' "$s"

# clearweb: publishes too
is "share clearweb" 200 "$(code -X POST "$A/page-share?name=sheetviews/calc&mode=clearweb")"
c=""
for _ in $(seq 1 30); do
  c=$(get "$A/c/sheetviews/calc"); grep -qF "$WORD" <<<"$c" && break; sleep 1
done
has   "/c shows a cell" "$WORD" "$c"
hasnt "/c shows no office: tags" "office:" "$c"
hasnt "/c shows no formula" "of:=" "$c"

# the published copy is the rendered HTML, never flat ODS (/fetch reads
# the vault, the body a peer keens)
vault() { get -G "$A/fetch" --data-urlencode "url=urb://$SHIP/sheetviews/calc" | jq -r .body; }
v=""
for _ in $(seq 1 30); do
  v=$(vault); grep -qF "$WORD" <<<"$v" && break; sleep 1
done
has   "the vault copy is the render" 'class="fods"' "$v"
hasnt "the vault copy holds no flat ODS" "office:document" "$v"
hasnt "the vault copy holds no office: tags" "office:" "$v"
hasnt "the vault copy holds no formula" "of:=" "$v"

# the urb:// reader, our own page: the %html branch, framed
r=$(get -G "$A" --data-urlencode "url=urb://$SHIP/sheetviews/calc")
has   "reader shows a cell" "$WORD" "$r"
hasnt "reader shows no flat ODS" "office:document" "$r"
has   "reader frames it (the %html branch)" "<iframe" "$r"

# a new revision never serves the old render
sed 's/>precedence</>RETITLED</' "$CORPUS/02-formulas.fods" >"$T/edit.fods"
is "save a new revision" 200 "$(code -X POST "$A/page-save?name=sheetviews/calc&type=fods" --data-binary "@$T/edit.fods")"
html=$(get "$A/page-source?name=sheetviews/calc&render=1" | jq -r .html)
has   "render=1 shows the new revision" "RETITLED" "$html"
hasnt "render=1 drops the old cell" "$WORD" "$html"
v=""
for _ in $(seq 1 30); do
  v=$(vault); grep -qF "RETITLED" <<<"$v" && break; sleep 1
done
has "the republished copy is the new render" "RETITLED" "$v"
s=$(get "$A/page-search?q=retitled")
has "page-search finds the new word" '"sheetviews/calc"' "$s"

# a hostile page renders as text, never as markup
is "make a hostile fods page" 200 "$(save sheetviews/h-markup fods "$T/h-markup.fods")"
h=$(get "$A/page-source?name=sheetviews/h-markup&render=1" | jq -r .html)
f=${h#*<div class=\"fods\">}; f=${f%%</div>*}
has   "the hostile sheet name shows as text" "&lt;img src=x onerror=PWNED()&gt;" "$f"
hasnt "no script from the page" "<script" "$f"
hasnt "no img element" "<img" "$f"

# a peer reads it over urb://
if [ -n "${B_URL:-}" ]; then
  BK="Cookie: $(cat "${B_COOKIE:?B_COOKIE}")"; BA="${B_URL%/}/apps/lattice"
  is "share for ships" 200 "$(code -X POST "$A/page-share?name=sheetviews/calc&mode=shared")"
  sleep 3
  r=""
  for _ in $(seq 1 20); do
    r=$(curl -s -m 120 -H "$BK" -G "$BA" --data-urlencode "url=urb://$SHIP/sheetviews/calc")
    grep -qF "RETITLED" <<<"$r" && break; sleep 3
  done
  has   "the peer's reader shows the new cell" "RETITLED" "$r"
  has   "the peer frames it (the %html branch)" "<iframe" "$r"
  hasnt "the peer gets no flat ODS" "office:document" "$r"

  # hostile spreadsheets, shared: the peer's reader shows their text and
  # nothing from them can run. audit parses the reader page's frame and
  # the document in its srcdoc, and prints the frame's sandbox, RENDER
  # for the fods table, TEXT for the words it shows, and one BAD line for
  # each element or attribute that could run, load or navigate.
  audit() { python3 -c 'import html,re,sys
from html.parser import HTMLParser
f=re.search(r"<iframe\b[^>]*>",sys.stdin.read())
if not f: sys.exit(1)
at=lambda n:(re.search(r"\s"+n+r"=\"([^\"]*)\"",f.group(0)) or [None,""])[1]
print("SANDBOX="+html.unescape(at("sandbox")) if re.search(r"\ssandbox=",f.group(0)) else "NO-SANDBOX")
doc=html.unescape(at("srcdoc"))
class A(HTMLParser):
  def __init__(s): super().__init__(); s.tag=None
  def handle_starttag(s,t,a):
    s.tag=t
    if ":" in t: print("BAD raw tag "+t)
    if t in ("iframe","img","svg","object","embed","form","meta","base","link","frame"): print("BAD element "+t)
    for k,v in a:
      v=(v or "").strip().lower()
      if k.startswith("on"): print("BAD handler "+k)
      if k in ("href","src","action","xlink:href") and not re.match(r"(https?:|mailto:|urb:|#|/[^/]|\.)",v): print("BAD "+k+"="+v[:40])
      if "evil.example" in v: print("BAD off-site "+k)
      if k=="style" and ("url(" in v or "expression(" in v): print("BAD style "+v[:40])
      if k=="class" and "fods" in v.split(): print("RENDER")
  def handle_data(s,d):
    if s.tag=="script" and re.search(r"PWNED|evil",d): print("BAD script from the page")
    elif s.tag=="style" and re.search(r"url\(|expression\(",d): print("BAD style sheet")
    elif d.strip(): print("TEXT "+d.strip()[:80])
A().feed(doc)'; }
  HOSTILE="markup links"
  for h in $HOSTILE; do
    code -X POST "$A/page-del?name=sheetviews/h-$h" >/dev/null
    is "make hostile $h" 200 "$(save "sheetviews/h-$h" fods "$T/h-$h.fods")"
    is "share hostile $h for ships" 200 "$(code -X POST "$A/page-share?name=sheetviews/h-$h&mode=shared")"
  done
  for h in $HOSTILE; do
    d=""
    for _ in $(seq 1 30); do
      d=$(curl -s -m 120 -H "$BK" -G "$BA" --data-urlencode "url=urb://$SHIP/sheetviews/h-$h" | audit) &&
        grep -qx RENDER <<<"$d" && break
      d=""; sleep 3
    done
    has   "peer reads hostile $h: a framed render" RENDER "$d"
    has   "peer reads hostile $h: the frame is sandboxed" "SANDBOX=" "$(head -1 <<<"$d")"
    hasnt "peer reads hostile $h: without same-origin" "allow-same-origin" "$(head -1 <<<"$d")"
    is    "peer reads hostile $h: nothing that runs, loads or navigates" "" "$(grep '^BAD' <<<"$d" | sort -u | head -5)"
  done
  has "peer reads hostile markup: its text shows" "Escaped markup in text" \
    "$(curl -s -m 120 -H "$BK" -G "$BA" --data-urlencode "url=urb://$SHIP/sheetviews/h-markup" | audit)"
  for h in $HOSTILE; do code -X POST "$A/page-del?name=sheetviews/h-$h" >/dev/null; done
fi

echo "fods-views: $fails failed"
exit $((fails > 0))
