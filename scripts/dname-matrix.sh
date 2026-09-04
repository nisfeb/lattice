#!/usr/bin/env bash
# Display names over the HTTP surface.
#   folder-new / page-save / template-less create with ?dname=
#   page-tree + page-dump carry `dname`; a valid name carries none
#   page-move: '' clears, a new dname applies, subtree names are carried,
#   same-path move sets the name alone
set -u
# Usage: LATTICE_URL=http://localhost:8080 LATTICE_COOKIE=~/.config/lattice-fs/cookie scripts/dname-matrix.sh
URL="${LATTICE_URL:-http://localhost:8080}"; URL="${URL%/}"
CKF="${LATTICE_COOKIE:-$HOME/.config/lattice-fs/cookie}"; CKF="${CKF/#\~/$HOME}"
CK=$(cat "$CKF")
B=$URL/apps/lattice
R=dn$$
fail=0; ok() { echo "PASS $1"; }; bad() { echo "FAIL $1"; fail=1; }
post() { curl -s -H "Cookie: $CK" -o /dev/null -w '%{http_code}' -X POST "$@"; }
node_field() {  # node_field <path> <field> -> value or <none>
  curl -s -H "Cookie: $CK" "$B/page-dump" | python3 -c "import sys,json
d=json.load(sys.stdin)
for n in d['nodes']:
    if n['path']=='$1': print(n.get('$2','<none>')); break
else: print('<missing>')"; }
tree_field() {
  curl -s -H "Cookie: $CK" "$B/page-tree" | python3 -c "import sys,json
d=json.load(sys.stdin)
for n in d['nodes']:
    if n['path']=='$1': print(n.get('$2','<none>')); break
else: print('<missing>')"; }

echo "-- folder with a display name"
s=$(post "$B/folder-new?name=$R/my-folder&dname=My%20Folder"); [ "$s" = 200 ] && ok "folder-new 200" || bad "folder-new $s"
sleep 1
[ "$(node_field $R/my-folder dname)" = "My Folder" ] && ok "dump: folder dname" || bad "dump: folder dname = $(node_field $R/my-folder dname)"
[ "$(tree_field $R/my-folder dname)" = "My Folder" ] && ok "tree: folder dname" || bad "tree: folder dname"

echo "-- page with a display name, and one without"
s=$(post --data-binary "# hi" "$B/page-save?name=$R/my-folder/my-page&type=md&new=1&dname=My%20Page"); [ "$s" = 200 ] && ok "page-save 200" || bad "page-save $s"
s=$(post --data-binary "# plain" "$B/page-save?name=$R/my-folder/plain&type=md&new=1"); [ "$s" = 200 ] && ok "plain page-save 200" || bad "plain page-save $s"
sleep 1
[ "$(node_field $R/my-folder/my-page dname)" = "My Page" ] && ok "dump: page dname" || bad "dump: page dname = $(node_field $R/my-folder/my-page dname)"
[ "$(node_field $R/my-folder/plain dname)" = "<none>" ] && ok "a valid name stores no dname" || bad "plain got dname $(node_field $R/my-folder/plain dname)"
[ "$(node_field $R/my-folder/my-page kind)" = "md" ] && ok "page fields intact" || bad "page kind $(node_field $R/my-folder/my-page kind)"

echo "-- rename to a valid name clears; rename with a dname applies"
s=$(post "$B/page-move?from=$R/my-folder/my-page&to=$R/my-folder/renamed&dname="); [ "$s" = 200 ] && ok "move (clear) 200" || bad "move $s"
sleep 1
[ "$(node_field $R/my-folder/renamed dname)" = "<none>" ] && ok "'' cleared the dname" || bad "dname survived clear: $(node_field $R/my-folder/renamed dname)"
s=$(post "$B/page-move?from=$R/my-folder/renamed&to=$R/my-folder/other-name&dname=Other%20Name"); [ "$s" = 200 ] && ok "move (set) 200" || bad "move $s"
sleep 1
[ "$(node_field $R/my-folder/other-name dname)" = "Other Name" ] && ok "new dname applied" || bad "dname not applied"

echo "-- same-path move sets the name alone (page and folder)"
s=$(post "$B/page-move?from=$R/my-folder/plain&to=$R/my-folder/plain&dname=Plain%20Page"); [ "$s" = 200 ] && ok "same-path move 200" || bad "same-path move $s"
s=$(post "$B/page-move?from=$R/my-folder&to=$R/my-folder&dname=Folder%20Renamed"); [ "$s" = 200 ] && ok "same-path folder move 200" || bad "same-path folder $s"
s=$(post "$B/page-move?from=$R/my-folder/plain&to=$R/my-folder/plain"); [ "$s" = 400 ] && ok "same-path without dname still 400" || bad "same-path no dname $s"
sleep 1
[ "$(node_field $R/my-folder/plain dname)" = "Plain Page" ] && ok "page dname set in place" || bad "in-place page dname $(node_field $R/my-folder/plain dname)"
[ "$(node_field $R/my-folder dname)" = "Folder Renamed" ] && ok "folder dname set in place" || bad "in-place folder dname"

echo "-- moving a folder carries the names of everything under it"
s=$(post "$B/folder-new?name=$R/my-folder/sub&dname=Sub%20Folder"); [ "$s" = 200 ] || bad "sub folder $s"
s=$(post "$B/page-move?from=$R/my-folder&to=$R/moved&dname=Moved%20Folder"); [ "$s" = 200 ] && ok "folder move 200" || bad "folder move $s"
sleep 2
[ "$(node_field $R/moved dname)" = "Moved Folder" ] && ok "moved folder has the new dname" || bad "moved folder dname $(node_field $R/moved dname)"
[ "$(node_field $R/moved/sub dname)" = "Sub Folder" ] && ok "subfolder dname carried" || bad "subfolder dname $(node_field $R/moved/sub dname)"
[ "$(node_field $R/moved/other-name dname)" = "Other Name" ] && ok "page dname carried" || bad "page dname carried: $(node_field $R/moved/other-name dname)"
[ "$(node_field $R/moved/plain dname)" = "Plain Page" ] && ok "second page dname carried" || bad "second page: $(node_field $R/moved/plain dname)"
[ "$(node_field $R/my-folder/plain dname)" = "<missing>" ] && ok "source is gone" || bad "source still there"

echo "-- delete"
s=$(post "$B/page-del?name=$R"); [ "$s" = 200 ] && ok "cleanup" || bad "cleanup $s"
exit $fail
