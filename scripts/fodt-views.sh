#!/usr/bin/env bash
# fodt-views.sh: a fodt page in every view a markdown page has (Writer
# plan, Task 7). Makes w7test/doc from a corpus file on a FAKE ship and
# checks the editor's open (page-source?render=1), the /x view, the
# clearweb view (/c), the urb:// reader, page-search, the published
# vault copy, and the render cache. Deletes its pages at the end.
#
# Usage:  LATTICE_URL=http://localhost:8151 LATTICE_COOKIE=/tmp/wep.cookie \
#           scripts/fodt-views.sh
# Env:    FODT_LARGE=1 also times 13-large.fodt (1.5 MB): its first view
#         renders (seconds), the second reads the cache (well under one).
#         B_URL and B_COOKIE: a second fake ship, which reads the page
#         over urb:// as a peer (it must already know A, a |hi each way),
#         and then four shared hostile corpus files: each must arrive as
#         a sandboxed frame holding an inert render.
#
# The vault copy and the reader are what a peer receives: a published
# fodt page is its rendered HTML under %html (spec, Decisions 4).
set -uo pipefail
URL="${LATTICE_URL:?LATTICE_URL}"; URL="${URL%/}"; A="$URL/apps/lattice"
CK="Cookie: $(cat "${LATTICE_COOKIE:?LATTICE_COOKIE}")"
HERE="$(cd "$(dirname "$0")" && pwd)"; CORPUS="$HERE/../tests/writer/corpus"
fails=0
ok()   { echo "ok    $1"; }
fail() { echo "FAIL  $1${2:+: $2}"; fails=$((fails+1)); }
is()   { if [ "$2" = "$3" ]; then ok "$1"; else fail "$1" "want [$2] got [$3]"; fi; }
has()  { if grep -qF -- "$2" <<<"$3"; then ok "$1"; else fail "$1" "no [$2]"; fi; }
hasnt(){ if grep -qF -- "$2" <<<"$3"; then fail "$1" "found [$2]"; else ok "$1"; fi; }
get()  { curl -s -m 120 -H "$CK" "$@"; }
code() { curl -s -m 120 -o /dev/null -w '%{http_code}' -H "$CK" "$@"; }
secs() { curl -s -m 120 -o /dev/null -w '%{time_total}' -H "$CK" "$@"; }
SHIP=$(curl -s -m 30 -H "$CK" "$URL/~/host")
[ -n "$SHIP" ] || { echo "FAIL  the ship answers /~/host"; exit 1; }
# the instance's tree path, for /x and the ball API
INST=/apps/shell.shell/desks/lattice.desk/desk/data/lattice.lattice_app

cleanup() {
  for p in w7test/doc w7test/big w7test/md w7test/h-script-iframe w7test/h-bad-links \
           w7test/h-style-injection w7test/h-external-image; do
    code -X POST "$A/page-del?name=$p" >/dev/null
  done
}
trap cleanup EXIT
cleanup

save() { code -X POST "$A/page-save?name=$1&type=$2&new=1" --data-binary "@$3"; }

# 02-headings: Heading 1 is "Heading level 1", the body text "a heading".
is "make a fodt page" 200 "$(save w7test/doc fodt "$CORPUS/02-headings.fodt")"
HEAD="Heading level 1"

# the editor's open
src=$(get "$A/page-source?name=w7test/doc&render=1")
is "page-source kind" fodt "$(jq -r .kind <<<"$src")"
is "page-source body is the file" "$(sha1sum <"$CORPUS/02-headings.fodt" | cut -d' ' -f1)" \
  "$(jq -j .body <<<"$src" | sha1sum | cut -d' ' -f1)"
html=$(jq -r .html <<<"$src")
has   "render=1 shows the heading" "$HEAD" "$html"
has   "render=1 is the fodt sheet" 'class="fodt"' "$html"
hasnt "render=1 shows no office: tags" "office:" "$html"
hasnt "render=1 shows no style names" "style-name" "$html"

# the cache, beside the page, made by that open
ci=$(get "$URL/grubbery/ball$INST/page/w7test/doc?info=1")
has "the render cache sits beside the page" '"name":"fodt.cache"' "$ci"

# the /x view, bare and standalone
x=$(get "$A/x/$SHIP$INST/page/w7test/doc/?embed=1")
has   "/x embed shows the heading" "$HEAD" "$x"
hasnt "/x embed shows no office: tags" "office:" "$x"
x=$(get "$A/x/$SHIP$INST/page/w7test/doc/")
has   "/x title is the first heading" "<title>$HEAD" "$x"

# search: words only
s=$(get "$A/page-search?q=heading")
has   "page-search finds a body word" '"w7test/doc"' "$s"
s=$(get "$A/page-search?q=style-name")
hasnt "page-search does not find style-name" '"w7test/doc"' "$s"
s=$(get "$A/page-search?q=office")
hasnt "page-search does not find office" '"w7test/doc"' "$s"

# clearweb: publishes too
is "share clearweb" 200 "$(code -X POST "$A/page-share?name=w7test/doc&mode=clearweb")"
c=""
for _ in $(seq 1 30); do
  c=$(get "$A/c/w7test/doc"); grep -qF "$HEAD" <<<"$c" && break; sleep 1
done
has   "/c shows the heading" "$HEAD" "$c"
hasnt "/c shows no office: tags" "office:" "$c"

# the published copy is the rendered HTML, never flat ODT (/fetch reads
# the vault, the body a peer keens)
vault() { get -G "$A/fetch" --data-urlencode "url=urb://$SHIP/w7test/doc" | jq -r .body; }
v=""
for _ in $(seq 1 30); do
  v=$(vault); grep -qF "$HEAD" <<<"$v" && break; sleep 1
done
has   "the vault copy is the render" 'class="fodt"' "$v"
hasnt "the vault copy holds no flat ODT" "office:document" "$v"
hasnt "the vault copy holds no office: tags" "office:" "$v"
revs=$(curl -sL -m 60 -H "$CK" "$URL/grubbery/ball$INST/pub/revs?raw=1")
has "the revision list names the page" '"/w7test/doc"' "$revs"

# the urb:// reader, our own page: the %html branch, framed
r=$(get -G "$A" --data-urlencode "url=urb://$SHIP/w7test/doc")
has   "reader shows the heading" "$HEAD" "$r"
hasnt "reader shows no office: tags" "office:document" "$r"
has   "reader title is the first heading" "<title>$HEAD" "$r"
has   "reader frames it (the %html branch)" "<iframe" "$r"

# a new revision never serves the old render
sed 's/Heading level 1/Retitled level 1/' "$CORPUS/02-headings.fodt" >"${TMPDIR:-/tmp}/w7-edit.fodt"
is "save a new revision" 200 "$(code -X POST "$A/page-save?name=w7test/doc&type=fodt" --data-binary "@${TMPDIR:-/tmp}/w7-edit.fodt")"
html=$(get "$A/page-source?name=w7test/doc&render=1" | jq -r .html)
has   "render=1 shows the new revision" "Retitled level 1" "$html"
hasnt "render=1 drops the old heading" "$HEAD" "$html"
v=""
for _ in $(seq 1 30); do
  v=$(vault); grep -qF "Retitled level 1" <<<"$v" && break; sleep 1
done
has "the republished copy is the new render" "Retitled level 1" "$v"
s=$(get "$A/page-search?q=retitled")
has "page-search finds the new word" '"w7test/doc"' "$s"
rm -f "${TMPDIR:-/tmp}/w7-edit.fodt"

# a hostile page renders as text, never as markup
is "make a hostile fodt page" 200 "$(save w7test/md fodt "$CORPUS/hostile/script-iframe.fodt")"
h=$(get "$A/page-source?name=w7test/md&render=1" | jq -r .html)
# (render-bare adds a script of its own after the fragment)
hasnt "no script from the page" "<script>window" "$h"
hasnt "no handler attribute" ' onerror="' "$h"
hasnt "no img element" "<img" "$h"
hasnt "no iframe element" "<iframe" "$h"

# a peer reads it over urb://
if [ -n "${B_URL:-}" ]; then
  BK="Cookie: $(cat "${B_COOKIE:?B_COOKIE}")"; BA="${B_URL%/}/apps/lattice"
  is "share for ships" 200 "$(code -X POST "$A/page-share?name=w7test/doc&mode=shared")"
  sleep 3
  r=""
  for _ in $(seq 1 20); do
    r=$(curl -s -m 120 -H "$BK" -G "$BA" --data-urlencode "url=urb://$SHIP/w7test/doc")
    grep -qF "Retitled level 1" <<<"$r" && break; sleep 3
  done
  has   "the peer's reader shows the heading" "Retitled level 1" "$r"
  has   "the peer frames it (the %html branch)" "<iframe" "$r"
  hasnt "the peer gets no flat ODT" "office:document" "$r"

  # hostile documents, shared: the peer's reader shows their text and
  # nothing from them can run. audit parses the reader page's frame and
  # the document in its srcdoc, and prints the frame's sandbox, RENDER
  # for the fodt sheet, TEXT for the words it shows, and one BAD line for
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
      if k=="class" and "fodt" in v.split(): print("RENDER")
  def handle_data(s,d):
    if s.tag=="script" and re.search(r"PWNED|evil",d): print("BAD script from the page")
    elif s.tag=="style" and re.search(r"url\(|expression\(",d): print("BAD style sheet")
    elif d.strip(): print("TEXT "+d.strip()[:80])
A().feed(doc)'; }
  HOSTILE="script-iframe bad-links style-injection external-image"
  for h in $HOSTILE; do
    is "make hostile $h" 200 "$(save "w7test/h-$h" fodt "$CORPUS/hostile/$h.fodt")"
    is "share hostile $h for ships" 200 "$(code -X POST "$A/page-share?name=w7test/h-$h&mode=shared")"
  done
  for h in $HOSTILE; do
    d=""
    for _ in $(seq 1 30); do
      d=$(curl -s -m 120 -H "$BK" -G "$BA" --data-urlencode "url=urb://$SHIP/w7test/h-$h" | audit) &&
        grep -qx RENDER <<<"$d" && break
      d=""; sleep 3
    done
    has   "peer reads hostile $h: a framed render" RENDER "$d"
    has   "peer reads hostile $h: the frame is sandboxed" "SANDBOX=" "$(head -1 <<<"$d")"
    hasnt "peer reads hostile $h: without same-origin" "allow-same-origin" "$(head -1 <<<"$d")"
    is    "peer reads hostile $h: nothing that runs, loads or navigates" "" "$(grep '^BAD' <<<"$d" | sort -u | head -5)"
  done
  has "peer reads hostile script-iframe: its text shows" "TEXT Escaped markup in text" \
    "$(curl -s -m 120 -H "$BK" -G "$BA" --data-urlencode "url=urb://$SHIP/w7test/h-script-iframe" | audit)"
  for h in $HOSTILE; do code -X POST "$A/page-del?name=w7test/h-$h" >/dev/null; done
fi

if [ -n "${FODT_LARGE:-}" ]; then
  # search ranks every page's words on each query, which takes seconds
  # for a page this big whatever its kind (a markdown page of the same
  # text costs the same), so the cache shows as the render it saves
  is "make the large page" 200 "$(save w7test/big fodt "$CORPUS/13-large.fodt")"
  s1=$(secs "$A/page-search?q=heading")
  s2=$(secs "$A/page-search?q=heading")
  echo "info  13-large page-search: first ${s1}s (renders), second ${s2}s"
  is "the second search reads the cached text" yes \
    "$(awk -v a="$s1" -v b="$s2" 'BEGIN{print (b < a - 3) ? "yes" : "no"}')"
  t1=$(secs "$A/page-source?name=w7test/big&render=1")
  echo "info  13-large render=1 after search filled the cache: ${t1}s"
  is "the open reads the cache" yes "$(awk -v t="$t1" 'BEGIN{print (t < 2) ? "yes" : "no"}')"
fi

echo "fodt-views: $fails failed"
exit $((fails > 0))
