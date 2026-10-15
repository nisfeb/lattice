#!/usr/bin/env bash
# HTTP API integration matrix for the lattice nexus. Exercises the editor
# routes, sharing (page + tree), recursive delete, the knowledge store, the
# compile-error surface, redirects, the auth boundary, the write and publish
# lifecycle and display names against a running ship (the tyr harness by
# default). Never run against production.
#
# Usage:  scripts/api-matrix.sh
# Env:    LATTICE_URL     ship base (default http://localhost:8080)
#         LATTICE_COOKIE  cookie file (default ~/.config/lattice-fs/cookie)
set -uo pipefail

. "$(dirname "${BASH_SOURCE[0]}")/lib/matrix.sh"
need_cookie
P="apimx-$$"                 # per-run namespace, deleted at the end

code(){ curl -s -o /dev/null -w '%{http_code}' "$@"; }
G()   { curl -s -H "$CK" "$@"; }
sc()  { code -H "$CK" "$@"; }
# field <route> <path> <key>: one node's field, as page-tree or page-dump
# reports it. <none> when the node has no such key, <missing> when there is
# no such node.
field() { G "$B/$1" | python3 -c "
import json,sys
ns=[n for n in json.load(sys.stdin)['nodes'] if n['path']=='$2']
print(ns[0].get('$3','<none>') if ns else '<missing>')"; }

# settle gate: right after a deploy the pier answers at 5-10s and every
# timing-adjacent assertion below would measure churn instead of behavior
okr=0
for i in $(seq 1 40); do
  t0=$(date +%s%N)
  curl -s -m 30 -o /dev/null -H "$CK" "$B"
  el=$(( ($(date +%s%N) - t0) / 1000000 ))
  if [ "$el" -lt 4000 ]; then okr=$((okr+1)); [ $okr -ge 3 ] && break; else okr=0; fi
  sleep 5
done
[ $okr -lt 3 ] && { echo "ship never settled"; exit 1; }

echo "==> editor routes"
is "folder-new"            200 "$(sc -X POST "$B/folder-new?name=$P")"
is "page-save type=md"     200 "$(sc -X POST "$B/page-save?name=$P/note&type=md&new=1" --data-binary '# api matrix')"
is "page-save no type"     200 "$(sc -X POST "$B/page-save?name=$P/untyped&new=1" --data-binary '(add 2 2)')"
is "create-only conflict"  409 "$(sc -X POST "$B/page-save?name=$P/note&type=md&new=1" --data-binary 'dupe')"
has "page-source body"     '# api matrix' "$(G "$B/page-source?name=$P/note")"
is "kind round-trips (md)" md    "$(G "$B/page-source?name=$P/note" | python3 -c 'import json,sys;print(json.load(sys.stdin)["kind"])')"
is "no type stores hoon"   hoon  "$(G "$B/page-source?name=$P/untyped" | python3 -c 'import json,sys;print(json.load(sys.stdin)["kind"])')"
is "tree carries the node" md    "$(field page-tree "$P/note" kind)"
has "page-preview renders" '<h1' "$(curl -s -H "$CK" -X POST "$B/page-preview?type=md" --data-binary '# preview probe')"

echo "==> sharing: page"
is "share=shared"          200 "$(sc -X POST "$B/page-share?name=$P/note&mode=shared")"
is "source sees shared"    shared "$(G "$B/page-source?name=$P/note" | python3 -c 'import json,sys;print(json.load(sys.stdin)["share"])')"
is "tree sees shared"      shared "$(field page-tree "$P/note" share)"
# an unknown mode is refused, and the page keeps the share it had (the
# server has answered 400 since 2026-07-30). Pin that so a client sending a
# bad mode can never silently *publish*
is "unknown mode refused" 400 "$(sc -X POST "$B/page-share?name=$P/note&mode=public")"
is "  ...and the share is unchanged" shared "$(G "$B/page-source?name=$P/note" | python3 -c 'import json,sys;print(json.load(sys.stdin)["share"])')"
is "share on missing page" 404 "$(sc -X POST "$B/page-share?name=$P/ghost&mode=shared")"

echo "==> sharing: tree (clearweb site publish)"
is "share-tree clearweb"   200 "$(sc -X POST "$B/page-share-tree?name=$P&mode=clearweb")"
sleep 2
is "public /c/ read, no cookie" 200 "$(code "$B/c/$P/note")"
is "tree reflects clearweb" clearweb "$(field page-tree "$P/note" share)"
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

echo "==> expected_updated apply-and-flag (H1)"
# A stale expected_updated no longer 409s: the save lands and is flagged
# conflicted, with the replaced rev in prior. A matching expected is not
# flagged. The losing body stays recoverable in history either way.
KC="$K-conflict"
is  "conflict seed"              200 "$(sc -X POST "$B/know-save?key=$KC" --data-binary 'seed body')"
R1="$(G -X POST "$B/know-save?key=$KC&expected_updated=~2020.1.1" --data-binary 'stale body')"
has "conflict stale flagged"     '"conflicted":true'  "$R1"
has "conflict stale still saved" '"ok":true'          "$R1"
has "conflict stale body landed" 'stale body'         "$(G "$B/know-read?key=$KC")"
T1="$(G "$B/know-read?key=$KC" | python3 -c 'import json,sys;print(json.load(sys.stdin)["updated"])')"
R2="$(G -X POST "$B/know-save?key=$KC&expected_updated=$T1" --data-binary 'fresh body')"
has "conflict match not flagged" '"conflicted":false' "$R2"
has "conflict match body landed" 'fresh body'         "$(G "$B/know-read?key=$KC")"
is  "cleanup conflict key"       200 "$(sc -X POST "$B/know-delete?key=$KC")"

echo "==> batch save"
# two new notes, a bad key, and a third that repeats the first: one writer
# poke, checked like single saves, including against earlier items
BB="$(G -X POST "$B/know-save-batch" -H 'content-type: application/json' --data-binary "$(python3 -c "
import json, sys
k = sys.argv[1]
body = 'batch matrix quokka lantern orchard ferry basalt meridian'
print(json.dumps({'items': [
  {'key': k + '/a', 'body': body, 'author': 'apimx'},
  {'key': k + '/b', 'body': 'batch matrix second note, unrelated words entirely', 'author': 'apimx'},
  {'key': 'Bad Key', 'body': 'x'},
  {'key': k + '/c', 'body': body, 'author': 'apimx'}]}))" "$K-batch")")"
batch_field() { printf '%s' "$BB" | python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1" 2>/dev/null; }
is "batch saved two"            2   "$(batch_field "d['saved']")"
is "batch results in order"     4   "$(batch_field "len(d['results'])")"
is "batch: bad key refused"     400 "$(batch_field "d['results'][2]['status']")"
is "batch: in-batch duplicate"  409 "$(batch_field "d['results'][3]['status']")"
has "batch item landed"         'quokka lantern' "$(G "$B/know-read?key=$K-batch/a")"
is "batch: refused not written" 404 "$(sc "$B/know-read?key=$K-batch/c")"
is "batch: over 50 refused"     400 "$(sc -X POST "$B/know-save-batch" -H 'content-type: application/json' --data-binary "$(python3 -c "import json; print(json.dumps({'items': [{'key': '/x%d' % i, 'body': 'x'} for i in range(51)]}))")")"
is "batch: bad shape refused"   400 "$(sc -X POST "$B/know-save-batch" -H 'content-type: application/json' --data-binary '{"items":[{"body":"no key"}]}')"
for x in a b; do sc -o /dev/null -X POST "$B/know-delete?key=$K-batch/$x" >/dev/null; done

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
is "  old folder gone"     "<missing>" "$(field page-tree "$P/mvdir/x" kind)"
is "move under itself 400" 400 "$(sc -X POST "$B/page-move?from=$P/mvdir2&to=$P/mvdir2/sub")"
is "move missing 404"      404 "$(sc -X POST "$B/page-move?from=$P/ghost-move&to=$P/anywhere")"
is "page-move gated"       403 "$(code -X POST "$B/page-move?from=$P/mvdir2&to=$P/free")"

echo "==> public forms: the unauthenticated write surface"
# the gate walk is the security boundary. Every refusal below must hold
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
# an earlier assertion in this file already submitted once. Start from zero
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

echo "==> deleting a page purges its comments"
# Comments live under /comments, not /page, so a page delete used to leave them
# in the moderation inbox attached to a path a NEW page could reuse.
cmt_count() { G "$B/comments-inbox" | python3 -c "
import json,sys
d=json.load(sys.stdin); i=d if isinstance(d,list) else d.get('items',[])
print(sum(1 for c in i if str(c.get('page','')).startswith('$1')))"; }
is "comment page created"   200 "$(sc -X POST "$B/page-save?name=$P-cmt&type=md&new=1" --data-binary '# c')"
is "comments enabled"       200 "$(sc -X POST "$B/page-comments?name=$P-cmt&on=1")"
sleep 2
# the body is a urlencoded form, so the space has to be encoded: a raw space
# makes the parse yield nothing and the route answers 400 'missing body'
is "comment accepted"       303 "$(sc -X POST "$B/comment?page=$P-cmt" --data 'body=purge+regression')"
sleep 3
is "comment is in the inbox"  1 "$(cmt_count "$P-cmt")"
is "page deleted"           200 "$(sc -X POST "$B/page-del?name=$P-cmt")"
sleep 4
is "and its comments went with it" 0 "$(cmt_count "$P-cmt")"
# the guard matters: cull-soft on an absent dir veto-crashes the writer, and
# most pages never had a comment
is "deleting a page with no comments still works" 200 "$(sc -X POST "$B/page-save?name=$P-nocmt&type=md&new=1" --data-binary '# n')"
sleep 2
is "  delete"               200 "$(sc -X POST "$B/page-del?name=$P-nocmt")"
sleep 2
is "  writer survived"      200 "$(sc "$B/page-tree")"

echo "==> page names: dot segments are refused (fuzz-api finding)"
# '.' and '..' are ordinary @ta knots, so the sanity check alone admits them and
# page-tree then hands clients a path that walks out of its own directory when
# joined onto a real filesystem path.
is "'..' segment refused"       400 "$(sc -X POST "$B/page-save?name=..%2Fetc&type=md&new=1" --data-binary '# x')"
is "'.' segment refused"        400 "$(sc -X POST "$B/page-save?name=.%2F$P-dot&type=md&new=1" --data-binary '# x')"
is "deep traversal refused"     400 "$(sc -X POST "$B/page-save?name=..%2F..%2F..%2Fetc%2Fpasswd&type=md&new=1" --data-binary '# x')"
is "bare '..' refused"          400 "$(sc -X POST "$B/page-save?name=..&type=md&new=1" --data-binary '# x')"
is "folder-new refuses too"     400 "$(sc -X POST "$B/folder-new?name=..%2Fetc")"
NOESC="$(G "$B/page-tree")"
if printf '%s' "$NOESC" | grep -qF '"../'; then bad "no traversal path in the tree" "found one"; else ok "no traversal path in the tree"; fi
# deletion stays permissive on purpose, so a page that predates the rule is
# still removable rather than stranded forever
is "page-del still accepts a dot name" 200 "$(sc -X POST "$B/page-del?name=..%2Fnonexistent")"

echo "==> bookmarks (folders + list + marks page)"
BM="urb://~zod/$P-mark"
is "bookmark with folder"   200 "$(sc -X POST "$B/bookmark?url=$BM&title=$P-title&folder=intel")"
sleep 2
has "list carries the url"    "$BM"       "$(G "$B/bookmarks")"
has "list carries the folder" '"intel"'   "$(G "$B/bookmarks")"
is "bookmark-move"          200 "$(sc -X POST "$B/bookmark-move?url=$BM&folder=osint")"
sleep 2
has "move refiles it"         '"osint"'   "$(G "$B/bookmarks")"
has "marks page groups by folder" '<h3 class="qh">osint</h3>' "$(G "$B/marks")"
has "marks page is searchable"    'id="bmq"'                  "$(G "$B/marks")"
has "marks page row carries search text" "$P-title"           "$(G "$B/marks")"
is "bookmarks gated"        403 "$(code "$B/bookmarks")"
is "marks page gated"       403 "$(code "$B/marks")"
# the home index has a urb:// address in its bar, so it must offer the star.
# Settings has no address, so it must not
has "reader offers the bookmark star" 'class="bm"' "$(G "$B")"
# the marks link must live in the BAR (not only the generated home), because
# an authored /index replaces the home view entirely
has "bar links to the bookmark list" 'href="/apps/lattice/marks"' "$(G "$B/settings")"
UBAR="$(G "$B/settings")"
if printf '%s' "$UBAR" | grep -qF 'class="bm"'; then bad "no star on settings" "starred"; else ok "no star on settings"; fi
is "unbookmark"             200 "$(sc -X POST "$B/unbookmark?url=$BM")"
sleep 2
UB="$(G "$B/bookmarks")"
if printf '%s' "$UB" | grep -qF -- "$BM"; then bad "unbookmark removes it" "still listed"; else ok "unbookmark removes it"; fi

echo "==> write lifecycle: moves, CAS, names"
# Each of these is a bug that shipped and was caught later by a review pass
# (#173-#178): silent move clobbering, the missing no-CAS spelling, invalid
# names answered 400 after the client queued them.
G -X POST "$B/page-save?name=$P/lc-src&type=md" --data-binary '# src' >/dev/null
G -X POST "$B/page-save?name=$P/lc-dst&type=md" --data-binary '# dst' >/dev/null
is "move onto an existing page is refused" 409 "$(sc -X POST "$B/page-move?from=$P/lc-src&to=$P/lc-dst")"
is "move to a fresh name lands"            200 "$(sc -X POST "$B/page-move?from=$P/lc-src&to=$P/lc-moved")"
has "batch base 0 is a no-CAS claim (applies clean)" '"conflicted":false' \
  "$(G -X POST "$B/page-save-batch?report=1" --data-binary "[{\"name\":\"$P/lc-dst\",\"type\":\"md\",\"body\":\"# dst base0\",\"base\":0}]")"
has "a genuinely stale base still conflicts (CAS intact)" '"conflicted":true' \
  "$(G -X POST "$B/page-save-batch?report=1" --data-binary "[{\"name\":\"$P/lc-dst\",\"type\":\"md\",\"body\":\"# dst stale\",\"base\":999}]")"
is "an invalid name is refused with 400"   400 "$(sc -X POST "$B/page-save?name=$P/Bad%20Name&type=md" --data-binary '# nope')"
is "a create onto a taken name is refused with 409" 409 "$(sc -X POST "$B/page-save?name=$P/lc-dst&type=md&new=1" --data-binary '# claim')"

echo "==> publish lifecycle: a shared page serves, moves and unpublishes"
# deleted pages left published, moved shared pages left unpublished, and the
# 'urbit' scope label privatizing restores. Read back through the reader at
# this ship's own urb:// key.
SHIP="$(G "$URL/~/host")"
view() { G "$B?url=urb%3A%2F%2F$SHIP%2F$1&u=lc$RANDOM"; }
G -X POST "$B/page-save?name=$P/lc-pub&type=md" --data-binary '# lifecycle pub body' >/dev/null
is "the archive label 'urbit' is accepted as shared" 200 "$(sc -X POST "$B/page-share?name=$P/lc-pub&mode=urbit")"
sleep 3
has "a shared page serves at its urb:// key" 'lifecycle pub body' "$(view "$P%2Flc-pub")"
G -X POST "$B/page-move?from=$P/lc-pub&to=$P/lc-pub2" >/dev/null
sleep 3
has "a MOVED shared page serves at its NEW key" 'lifecycle pub body' "$(view "$P%2Flc-pub2")"
G -X POST "$B/page-del?name=$P/lc-pub2" >/dev/null
sleep 3
hasnt "a DELETED shared page stops serving" 'lifecycle pub body' "$(view "$P%2Flc-pub2")"

echo "==> mesa: the remote-scry namespace backfill"
# backfill answers and reports a count. Harmless to re-run (the route's own
# comment): each re-grow lands a fresh case on the same rev spur.
r="$(G -X POST "$B/pub-regrow")"
has "pub-regrow answers ok" '"ok":true' "$r"
has "pub-regrow reports a grown count" '"grown":' "$r"
# The rest of mesa needs a second ship, so it is a manual procedure, not a
# check. Do not fake it with a single-ship curl.
#
# A publish must land a namespace binding readable by keen. The spar path
# the reader builds is +keen-path. Note the EMPTY SEGMENT after the agent
# name. It is load-bearing. Without it gall routes into the agent's
# +on-peek instead of the scry farm, and the keen parks forever. The path:
#     /g/x/1/grubbery//1/pub/page/<name>/<rev>
# From a peer's dojo (a keen is answered by the OTHER ship's kernel):
#     -keen [~tyr /g/x/1/grubbery//1/pub/page/<name>/<rev>]
#   expect a [%gmi body] page. After page-del, a keen at the NEXT cass
#   (rev+1) answers the [%del ''] tombstone the delete grew.
#
# READ side (phase C), peer reads:
#   1. on ~peer (running the same lattice): page-save a page, page-share it.
#   2. on this ship: POST /follow?ship=~peer. GET /follows must list the
#      peer, and the entry must survive a restart. The follow set is one
#      covering grub, not fiber state.
#   3. read the page here (GET /apps/lattice?url=urb://~peer/<name>). Expect
#      the body.
#   4. edit the page on ~peer, re-read here. The new body must come back.
#      The reader holds no cache, so there is nothing to invalidate.
#   5. stop ~peer entirely and read. +read-pub-index-remote answers ~ and
#      the read fails bounded, on +peek-remote-wait's own deadline. It must
#      never park the request fiber waiting on a ship that is gone.
#
# NOT converted, and not pending: /fetch, the web reader and the /x/
# explorer stay on peek-remote, since no rev is knowable in a per-request
# fiber (see the comment on +read-page-body). Every write path (comments,
# /remote-save, share notices) stays on the weir-gated poke by design.
#
# SUBSCRIPTION leg (mesa D2), wave -> keen. The reader rides ONE keep on the
# peer's page gmi grub. The keep's wave (the initial bond AND every edit)
# carries the grub's cass = the rev the publisher last grew, and the fiber
# keens the body at exactly that rev. No pointer, no seq, no peek fallback.
# With ~peer running this same overlay:
#   1. on ~peer: page-save + page-share a page P.
#   2. on this ship: POST /sub?url=urb://~peer/P. The BOND wave alone must
#      carry P's current cass and fetch the body at that rev, with NO edit
#      on ~peer. That is the initial-bond leg. /subs must list P.
#   3. edit P on ~peer. Expect here: the wave carries P's new cass, the
#      fiber keens /pub/page/P/<rev> (publisher log shows NO lattice peek),
#      and lrev advances to that rev.
#   4. reboot THIS ship, then edit P on ~peer while it is down, restart.
#      The re-armed keep's bond wave carries the newest cass and the missed
#      edit lands. Offline catch-up rides the same bond leg as step 2.
#   5. page-del P on ~peer. The delete grows a [%del ''] tombstone at the
#      post-cull cass. The wave names it and the keen here hits it, so the
#      delete is noticed as it happens. A re-save of P after that must
#      still be picked up (rev keeps rising past the tombstone).
#   6. the mixed-fleet limitation, BY DESIGN: subscribe to a peer that
#      does not mirror (old lattice / never regrown). Every wave keens an
#      unbound spur. Each wave costs one retry then a give-up (~20s in the
#      fiber, lrev NOT advanced) and nothing lands. The abandoned
#      request is %yawn-cancelled, so parked keens never pile up on the
#      publisher. The subscription starts working the moment the peer runs
#      /pub-regrow.

echo "==> display names: create"
# folder-new and page-save take ?dname=. page-tree and page-dump carry it,
# and a name that was valid as typed carries none.
R="dn$$"                     # its own namespace, deleted at the end of this
is "folder-new with a dname"      200 "$(sc -X POST "$B/folder-new?name=$R/my-folder&dname=My%20Folder")"
sleep 1
is "dump: folder dname"           "My Folder" "$(field page-dump "$R/my-folder" dname)"
is "tree: folder dname"           "My Folder" "$(field page-tree "$R/my-folder" dname)"
is "page-save with a dname"       200 "$(sc -X POST "$B/page-save?name=$R/my-folder/my-page&type=md&new=1&dname=My%20Page" --data-binary '# hi')"
is "plain page-save"              200 "$(sc -X POST "$B/page-save?name=$R/my-folder/plain&type=md&new=1" --data-binary '# plain')"
sleep 1
is "dump: page dname"             "My Page" "$(field page-dump "$R/my-folder/my-page" dname)"
is "a valid name stores no dname" "<none>" "$(field page-dump "$R/my-folder/plain" dname)"
is "page fields intact"           md "$(field page-dump "$R/my-folder/my-page" kind)"

echo "==> display names: page-move"
# '' clears, a new dname applies, a same-path move sets the name alone, and
# a folder move carries the names of everything under it
is "move (clear)"                 200 "$(sc -X POST "$B/page-move?from=$R/my-folder/my-page&to=$R/my-folder/renamed&dname=")"
sleep 1
is "'' cleared the dname"         "<none>" "$(field page-dump "$R/my-folder/renamed" dname)"
is "move (set)"                   200 "$(sc -X POST "$B/page-move?from=$R/my-folder/renamed&to=$R/my-folder/other-name&dname=Other%20Name")"
sleep 1
is "new dname applied"            "Other Name" "$(field page-dump "$R/my-folder/other-name" dname)"
is "same-path move"               200 "$(sc -X POST "$B/page-move?from=$R/my-folder/plain&to=$R/my-folder/plain&dname=Plain%20Page")"
is "same-path folder move"        200 "$(sc -X POST "$B/page-move?from=$R/my-folder&to=$R/my-folder&dname=Folder%20Renamed")"
is "same-path without dname still 400" 400 "$(sc -X POST "$B/page-move?from=$R/my-folder/plain&to=$R/my-folder/plain")"
sleep 1
is "page dname set in place"      "Plain Page" "$(field page-dump "$R/my-folder/plain" dname)"
is "folder dname set in place"    "Folder Renamed" "$(field page-dump "$R/my-folder" dname)"
is "sub folder with a dname"      200 "$(sc -X POST "$B/folder-new?name=$R/my-folder/sub&dname=Sub%20Folder")"
is "folder move"                  200 "$(sc -X POST "$B/page-move?from=$R/my-folder&to=$R/moved&dname=Moved%20Folder")"
sleep 2
is "moved folder has the new dname" "Moved Folder" "$(field page-dump "$R/moved" dname)"
is "subfolder dname carried"      "Sub Folder" "$(field page-dump "$R/moved/sub" dname)"
is "page dname carried"           "Other Name" "$(field page-dump "$R/moved/other-name" dname)"
is "second page dname carried"    "Plain Page" "$(field page-dump "$R/moved/plain" dname)"
is "source is gone"               "<missing>" "$(field page-dump "$R/my-folder/plain" dname)"

echo "==> display names: per segment, the folders a save creates get theirs too"
# "$R/Sub Folder/Deep Page" typed -> name $R/sub-folder/deep-page, dnames "/Sub Folder/Deep Page"
is "nested page-save"             200 "$(sc -X POST "$B/page-save?name=$R/sub-folder/deep-page&type=md&new=1&dname=Deep%20Page&dnames=%2FSub%20Folder%2FDeep%20Page" --data-binary '# deep')"
sleep 1
is "the folder the save made has its display name" "Sub Folder" "$(field page-dump "$R/sub-folder" dname)"
is "the page has its display name" "Deep Page" "$(field page-dump "$R/sub-folder/deep-page" dname)"
is "a segment that was fine as typed gets none" "<none>" "$(field page-dump "$R" dname)"
# a second page inside, typed with the plain slug, must not clear the folder's name
is "a second page inside"         200 "$(sc -X POST "$B/page-save?name=$R/sub-folder/more&type=md&new=1" --data-binary '# more')"
sleep 1
is "a plain save inside keeps the folder's name" "Sub Folder" "$(field page-dump "$R/sub-folder" dname)"
# a move into a new typed folder names that folder
is "move into a new folder"       200 "$(sc -X POST "$B/page-move?from=$R/sub-folder/more&to=$R/new-dir/more&dname=&dnames=%2FNew%20Dir%2F")"
sleep 1
is "the folder the move made has its display name" "New Dir" "$(field page-dump "$R/new-dir" dname)"
is "the moved page has none"      "<none>" "$(field page-dump "$R/new-dir/more" dname)"
# nested folder-new names every new segment
is "nested folder-new"            200 "$(sc -X POST "$B/folder-new?name=$R/alpha-one/beta-two&dnames=%2FAlpha%20One%2FBeta%20Two&dname=Beta%20Two")"
sleep 1
is "outer folder named"           "Alpha One" "$(field page-dump "$R/alpha-one" dname)"
is "inner folder named"           "Beta Two" "$(field page-dump "$R/alpha-one/beta-two" dname)"
is "display-name pages deleted"   200 "$(sc -X POST "$B/page-del?name=$R")"

echo "==> scoped agent key (pages)"
# mint: read = $P (the test namespace), write = $P/out
# seed the note and out folder before the recursive-delete block clears them
is "seed note for scoped read" 200 "$(sc -X POST "$B/page-save?name=$P/note&type=md" --data-binary '# scope test')"
is "seed out/s1 for scoped write" 200 "$(sc -X POST "$B/folder-new?name=$P/out")"
KEYJSON="$(G -X POST "$B/key-mint" -H 'content-type: application/json' --data-binary "$(python3 -c "import json,sys;print(json.dumps({'name':'apimx-scoped','by':'apimx','scope':{'memory':'none','pages':{'some':{'read':['/'+sys.argv[1]],'write':['/'+sys.argv[1]+'/out']}},'web':{'off':None},'sensitive':False}}))" "$P")")"
TOK="$(printf '%s' "$KEYJSON" | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')"
# keyed curl helpers: no cookie, only the Bearer token
BG() { curl -s -H "Authorization: Bearer $TOK" "$@"; }
BC() { curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOK" "$@"; }
is  "scoped read granted"      200 "$(BC "$B/page-source?name=$P/note")"
is  "scoped read ungranted"    403 "$(BC "$B/page-source?name=other/page")"
is  "scoped write granted"     200 "$(BC -X POST "$B/page-save?name=$P/out/s1&type=md" --data-binary 'scoped write')"
is  "scoped write ungranted"   403 "$(BC -X POST "$B/page-save?name=$P/note&type=md" --data-binary 'nope')"
has "tree hides ungranted"     "$P/out" "$(BG "$B/page-tree")"
is  "tree omits other ns"      "" "$(BG "$B/page-tree" | python3 -c 'import json,sys;print("".join(n["path"] for n in json.load(sys.stdin).get("nodes",[]) if not n["path"].startswith(sys.argv[1])))' "$P")"
is  "scoped write hoon refused" 403 "$(BC -X POST "$B/page-save?name=$P/out/x&type=hoon" --data-binary '|=(x=@ x)')"

echo "==> sensitive pages"
is "mark sensitive (owner)"          200 "$(sc -X POST "$B/page-sensitive?name=$P/note&on=1")"
sleep 2
# uncleared scoped key: sensitive page is hidden/refused
is "sensitive read blocked (uncleared)"  403 "$(BC "$B/page-source?name=$P/note")"
is "sensitive write blocked (uncleared)" 403 "$(BC -X POST "$B/page-save?name=$P/note&type=md" --data-binary 'nope')"
is "tree hides sensitive (uncleared)"    "" "$(BG "$B/page-tree" | python3 -c 'import json,sys;print("".join(str(1) for n in json.load(sys.stdin).get("nodes",[]) if n["path"]==sys.argv[1]))' "$P/note")"

# cross-surface taint: a CLEARED key may read the sensitive page, but doing so
# taints it, after which it may not write a non-sensitive page (the same
# tainted check that already gates non-sensitive memory writes). $P/note is
# still marked sensitive here.
CKEYJSON="$(G -X POST "$B/key-mint" -H 'content-type: application/json' --data-binary "$(python3 -c "import json,sys;print(json.dumps({'name':'apimx-cleared','by':'apimx','scope':{'memory':'none','pages':{'some':{'read':['/'+sys.argv[1]],'write':['/'+sys.argv[1]+'/out']}},'web':{'off':None},'sensitive':True}}))" "$P")")"
CTOK="$(printf '%s' "$CKEYJSON" | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')"
CC() { curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $CTOK" "$@"; }
is "cleared plain write before taint" 200 "$(CC -X POST "$B/page-save?name=$P/out/pre&type=md" --data-binary 'ok')"
is "cleared reads sensitive page"     200 "$(CC "$B/page-source?name=$P/note")"
sleep 2
is "tainted key plain write refused"  403 "$(CC -X POST "$B/page-save?name=$P/out/post&type=md" --data-binary 'blocked')"
CKID="$(printf '%s' "$CKEYJSON" | python3 -c 'import json,sys;print(json.load(sys.stdin)["key"]["id"])')"
sc -o /dev/null -X POST "$B/key-revoke?id=$CKID" >/dev/null

# clear the mark and confirm access restored
is "unmark sensitive (owner)"        200 "$(sc -X POST "$B/page-sensitive?name=$P/note&on=0")"
sleep 2
is "uncleared key reads after unmark" 200 "$(BC "$B/page-source?name=$P/note")"

# revoke the test key
KID="$(printf '%s' "$KEYJSON" | python3 -c 'import json,sys;print(json.load(sys.stdin)["key"]["id"])')"
sc -o /dev/null -X POST "$B/key-revoke?id=$KID" >/dev/null

echo "==> recursive folder delete"
is "page-del on folder" 200 "$(sc -X POST "$B/page-del?name=$P")"
sleep 2
is "subtree gone from tree" "<missing>" "$(field page-tree "$P/note" kind)"
is "page-tree healthy after everything" 200 "$(sc "$B/page-tree")"

finish
