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

echo "==> recursive folder delete"
is "page-del on folder" 200 "$(sc -X POST "$B/page-del?name=$P")"
sleep 2
is "subtree gone from tree" NO-NODE "$(G "$B/page-tree" | node_field "$P/note" kind)"
is "page-tree healthy after everything" 200 "$(sc "$B/page-tree")"

echo
if [ "$fail" = 0 ]; then echo "api-matrix PASSED"; else echo "api-matrix FAILED"; fi
exit "$fail"
