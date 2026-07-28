#!/usr/bin/env bash
# HTTP API integration matrix for the lattice nexus. Exercises the editor
# routes, sharing (page + tree), recursive delete, the knowledge store, the
# compile-error surface, redirects, and the auth boundary against a running
# ship (the tyr harness by default). Never run against production.
#
# Usage:  scripts/api-matrix.sh
# Env:    LATTICE_URL     ship base (default http://localhost:8080)
#         LATTICE_COOKIE  cookie file (default ~/.config/lattice-fs/cookie)
set -uo pipefail

URL="${LATTICE_URL:-http://localhost:8080}"; URL="${URL%/}"
CKF="${LATTICE_COOKIE:-$HOME/.config/lattice-fs/cookie}"
CK="Cookie: $(cat "$CKF")"
B="$URL/apps/lattice"
P="apimx-$$"                 # per-run namespace, deleted at the end

fail=0
ok()  { echo "  ok   - $1"; }
bad() { echo "  FAIL - $1${2:+ ($2)}"; fail=1; }
# is <name> <expected> <actual>
is()  { if [ "$3" = "$2" ]; then ok "$1"; else bad "$1" "want $2 got $3"; fi; }
has() { if printf '%s' "$3" | grep -qF -- "$2"; then ok "$1"; else bad "$1" "no '$2' in: $(printf '%s' "$3" | head -c 120)"; fi; }
code(){ curl -s -o /dev/null -w '%{http_code}' "$@"; }
G()   { curl -s -H "$CK" "$@"; }
sc()  { code -H "$CK" "$@"; }
node_field() { python3 -c "
import json,sys
ns=[n for n in json.load(sys.stdin)['nodes'] if n['path']=='$1']
print(ns[0].get('$2','ABSENT') if ns else 'NO-NODE')"; }

echo "==> editor routes"
is "folder-new"            200 "$(sc -X POST "$B/folder-new?name=$P")"
is "page-save type=md"     200 "$(sc -X POST "$B/page-save?name=$P/note&type=md&new=1" --data-binary '# api matrix')"
is "page-save no type"     200 "$(sc -X POST "$B/page-save?name=$P/untyped&new=1" --data-binary '(add 2 2)')"
is "create-only conflict"  409 "$(sc -X POST "$B/page-save?name=$P/note&type=md&new=1" --data-binary 'dupe')"
has "page-source body"     '# api matrix' "$(G "$B/page-source?name=$P/note")"
is "kind round-trips (md)" md    "$(G "$B/page-source?name=$P/note" | python3 -c 'import json,sys;print(json.load(sys.stdin)["kind"])')"
is "no type stores hoon"   hoon  "$(G "$B/page-source?name=$P/untyped" | python3 -c 'import json,sys;print(json.load(sys.stdin)["kind"])')"
is "tree carries the node" md    "$(G "$B/page-tree" | node_field "$P/note" kind)"
has "page-preview renders" '<h1' "$(curl -s -H "$CK" -X POST "$B/page-preview?type=md" --data-binary '# preview probe')"

echo "==> sharing: page"
is "share=shared"          200 "$(sc -X POST "$B/page-share?name=$P/note&mode=shared")"
is "source sees shared"    shared "$(G "$B/page-source?name=$P/note" | python3 -c 'import json,sys;print(json.load(sys.stdin)["share"])')"
is "tree sees shared"      shared "$(G "$B/page-tree" | node_field "$P/note" share)"
# an unknown mode folds to private on the server; pin that so a client
# sending a bad mode can never silently *publish*
is "unknown mode folds to private" 200 "$(sc -X POST "$B/page-share?name=$P/note&mode=public")"
is "  ...and lands private" private "$(G "$B/page-source?name=$P/note" | python3 -c 'import json,sys;print(json.load(sys.stdin)["share"])')"
is "share on missing page" 404 "$(sc -X POST "$B/page-share?name=$P/ghost&mode=shared")"

echo "==> sharing: tree (clearweb site publish)"
is "share-tree clearweb"   200 "$(sc -X POST "$B/page-share-tree?name=$P&mode=clearweb")"
sleep 2
is "public /c/ read, no cookie" 200 "$(code "$B/c/$P/note")"
is "tree reflects clearweb" clearweb "$(G "$B/page-tree" | node_field "$P/note" share)"
is "share-tree private"    200 "$(sc -X POST "$B/page-share-tree?name=$P&mode=private")"
sleep 2
is "public read revoked"   404 "$(code "$B/c/$P/note")"

echo "==> compile errors (hoon page)"
is "save broken hoon"      200 "$(sc -X POST "$B/page-save?name=$P/broken&type=hoon&new=1" --data-binary '|=(x=@ (undefined-arm x))')"
sleep 3
errs="$(G "$B/page-errors?name=$P/broken")"
if [ -n "$(printf '%s' "$errs" | tr -d '[:space:]')" ]; then ok "page-errors reports the failure"; else bad "page-errors reports the failure" "empty"; fi

echo "==> knowledge store"
K="apimx/$$"
is "know-save"    200 "$(sc -X POST "$B/know-save?key=$K" --data-binary 'api matrix memory')"
has "know-read"   'api matrix memory' "$(G "$B/know-read?key=$K")"
is "know-tag"     200 "$(sc -X POST "$B/know-tag?key=$K&tag=APIMX")"
has "tags case-fold" '"apimx"' "$(G "$B/know-read?key=$K")"
has "know-explore by tag" "$K" "$(G "$B/know-explore?tags=apimx&match=all")"
is "know-move"    200 "$(sc -X POST "$B/know-move?from=$K&to=$K-moved")"
has "moved body"  'api matrix memory' "$(G "$B/know-read?key=$K-moved")"
has "history exists" '"revisions"' "$(G "$B/know-history?key=$K-moved")"
is "know-delete"  200 "$(sc -X POST "$B/know-delete?key=$K-moved")"
is "read after delete" 404 "$(sc "$B/know-read?key=$K-moved")"
is "know-restore" 200 "$(sc -X POST "$B/know-restore?key=$K-moved")"
has "restored body" 'api matrix memory' "$(G "$B/know-read?key=$K-moved")"
is "cleanup memory" 200 "$(sc -X POST "$B/know-delete?key=$K-moved")"

echo "==> redirects"
loc="$(curl -s -o /dev/null -w '%{redirect_url}' -H "$CK" "$B/edit?name=$P/note")"
has "/edit redirects to /app with name" "app?name=$P/note" "$loc"

echo "==> auth boundary (no cookie)"
is "page-tree gated"    403 "$(code "$B/page-tree")"
is "know-list gated"    403 "$(code "$B/know-list")"
is "page-save gated"    403 "$(code -X POST "$B/page-save?name=$P/evil&type=md" --data-binary 'x')"
is "manifest public (PWA)" 200 "$(code "$B/manifest.webmanifest")"
is "icon-192 public (PWA)"      200 "$(code "$B/icon-192.png")"

echo "==> version history + backlinks (new routes)"
is "page-history"          200 "$(sc "$B/page-history?name=$P/note")"
has "history has revisions" '"revisions"' "$(G "$B/page-history?name=$P/note")"
R1=$(G "$B/page-history?name=$P/note" | python3 -c 'import json,sys; print(json.load(sys.stdin)["revisions"][-1]["rev"])')
has "page-source-at reads a revision" '"body"' "$(G "$B/page-source-at?name=$P/note&rev=$R1")"
is "page-source-at bad rev"    400 "$(sc "$B/page-source-at?name=$P/note&rev=notanumber")"
is "page-source-at absent rev"   404 "$(sc "$B/page-source-at?name=$P/note&rev=999999")"
is "page-source-at 4-digit rev parses" 404 "$(sc "$B/page-source-at?name=$P/note&rev=1000")"
is "page-backlinks"        200 "$(sc "$B/page-backlinks?name=$P/note")"
has "backlinks shape"      '"links"' "$(G "$B/page-backlinks?name=$P/note")"

echo "==> page-source render=1 (editor single-request open)"
has "render=1 carries html" '"html"' "$(G "$B/page-source?name=$P/note&render=1")"
r=$(G "$B/page-source?name=$P/note")
if printf '%s' "$r" | grep -qF '"html"'; then bad "plain page-source omits html"; else ok "plain page-source omits html"; fi

echo "==> page-move (server-side rename, one request)"
is "seed a page to move"   200 "$(sc -X POST "$B/page-save?name=$P/mv-src&type=md&new=1" --data-binary "see [[$P/mv-src]]")"
is "single page move"      200 "$(sc -X POST "$B/page-move?from=$P/mv-src&to=$P/mv-dst")"
sleep 2
is "  old name gone"       404 "$(sc "$B/page-source?name=$P/mv-src")"
has "  body moved + self-wikilink rewritten" "[[$P/mv-dst]]" "$(G "$B/page-source?name=$P/mv-dst")"
is "folder move"           200 "$(sc -X POST "$B/folder-new?name=$P/mvdir")"
is "  page inside"         200 "$(sc -X POST "$B/page-save?name=$P/mvdir/x&type=md&new=1" --data-binary 'inside')"
is "  move the folder"     200 "$(sc -X POST "$B/page-move?from=$P/mvdir&to=$P/mvdir2")"
sleep 2
has "  page landed"        'inside' "$(G "$B/page-source?name=$P/mvdir2/x")"
is "  old folder gone"     NO-NODE "$(G "$B/page-tree" | node_field "$P/mvdir/x" kind)"
is "move under itself 400" 400 "$(sc -X POST "$B/page-move?from=$P/mvdir2&to=$P/mvdir2/sub")"
is "move missing 404"      404 "$(sc -X POST "$B/page-move?from=$P/ghost-move&to=$P/anywhere")"
is "page-move gated"       403 "$(code -X POST "$B/page-move?from=$P/mvdir2&to=$P/free")"

echo "==> public forms: the unauthenticated write surface"
# the gate walk is the security boundary — every refusal below must hold
is "forms flag on"         200 "$(sc -X POST "$B/page-forms?name=$P/note&on=1")"
sleep 2
is "  submit to a NON-clearweb page -> 404" 404 "$(code -X POST "$B/f/$P/note" --data-binary 'entry=x')"
is "clearweb on"           200 "$(sc -X POST "$B/page-share-tree?name=$P&mode=clearweb")"
sleep 2
is "  submit with clearweb+flag -> 303"     303 "$(code -X POST "$B/f/$P/note" --data-binary 'entry=probe')"
is "forms flag off"        200 "$(sc -X POST "$B/page-forms?name=$P/note&on=0")"
sleep 2
is "  submit with forms OFF -> 403"         403 "$(code -X POST "$B/f/$P/note" --data-binary 'entry=x')"
is "forms flag back on"    200 "$(sc -X POST "$B/page-forms?name=$P/note&on=1")"
sleep 2
python3 -c "print('entry=' + 'x'*9000)" > /tmp/apimx-big-$$.txt
is "  oversize body -> 413"                 413 "$(code -X POST "$B/f/$P/note" --data-binary @/tmp/apimx-big-$$.txt)"
rm -f /tmp/apimx-big-$$.txt
is "  submit to a nonexistent page -> 404"  404 "$(code -X POST "$B/f/$P/ghost" --data-binary 'entry=x')"
tc=$(code -X POST "$B/f/$P/../../etc" --data-binary 'entry=x')
case "$tc" in 200|303) bad "  path traversal refused" "accepted with $tc" ;; *) ok "  path traversal refused ($tc)" ;; esac
echo "==> form limits: absolute cap + cooldown"
is "set cap=2 gap=0"       200 "$(sc -X POST "$B/page-forms?name=$P/note&on=1&cap=2&gap=0")"
# an earlier assertion in this file already submitted once — start from zero
is "zero the counter first" 200 "$(sc -X POST "$B/page-forms-reset?name=$P/note")"
sleep 2
has "status reports the cap" '"cap":2' "$(G "$B/page-forms?name=$P/note")"
is "  submission 1 -> 303"  303 "$(code -X POST "$B/f/$P/note" --data-binary 'entry=1')"
sleep 2
is "  submission 2 -> 303"  303 "$(code -X POST "$B/f/$P/note" --data-binary 'entry=2')"
sleep 2
is "  over the cap -> 429"  429 "$(code -X POST "$B/f/$P/note" --data-binary 'entry=3')"
is "reset the counter"      200 "$(sc -X POST "$B/page-forms-reset?name=$P/note")"
sleep 2
has "  counter is zero"    '"count":0' "$(G "$B/page-forms?name=$P/note")"
is "set gap=30 cap=0"      200 "$(sc -X POST "$B/page-forms?name=$P/note&on=1&cap=0&gap=30")"
sleep 2
is "  first submission -> 303" 303 "$(code -X POST "$B/f/$P/note" --data-binary 'entry=x')"
is "  inside cooldown -> 429"  429 "$(code -X POST "$B/f/$P/note" --data-binary 'entry=y')"
is "page-forms-reset gated"    403 "$(code -X POST "$B/page-forms-reset?name=$P/note")"
is "clear limits"          200 "$(sc -X POST "$B/page-forms?name=$P/note&on=1&cap=0&gap=0")"

is "private again"         200 "$(sc -X POST "$B/page-share-tree?name=$P&mode=private")"

echo "==> auth boundary on the NEW owner routes"
is "page-history gated"     403 "$(code "$B/page-history?name=$P/note")"
is "page-source-at gated"   403 "$(code "$B/page-source-at?name=$P/note&rev=1")"
is "page-backlinks gated"   403 "$(code "$B/page-backlinks?name=$P/note")"
is "page-forms gated"       403 "$(code -X POST "$B/page-forms?name=$P/note&on=1")"

echo "==> recursive folder delete"
is "page-del on folder" 200 "$(sc -X POST "$B/page-del?name=$P")"
sleep 2
is "subtree gone from tree" NO-NODE "$(G "$B/page-tree" | node_field "$P/note" kind)"
is "page-tree healthy after everything" 200 "$(sc "$B/page-tree")"

echo
if [ "$fail" = 0 ]; then echo "api-matrix PASSED"; else echo "api-matrix FAILED"; fi
exit "$fail"
