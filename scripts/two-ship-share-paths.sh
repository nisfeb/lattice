#!/usr/bin/env bash
# Two-ship check that every way a client shares a page really works: ship
# A shares a fresh page with ship B, and B must then READ its text through
# its own lattice (/browse-file, as B's reader opens a shared page, and
# /urb-read, the urb:// reader and its agents' urb_read). For edit, B must
# also WRITE it (/remote-save) and A must see the new text. Unsharing, the
# same client's way, must take the read away again.
#
# A page shared from the Rune client could not be read by the other ship:
# Rune names a page in /share-group-save as <base>/page/<name>/code, the
# web UI as the page's dir, and the server stored a dir road on the code
# file, which grants nothing (nisfeb/lattice#495). Every suite passed,
# since they shared only the web UI's way and looked at groups, not at a
# read by the other ship. The shapes, each for read and for edit:
#
#   a. the web share box: POST /share-file?name=<page>&ship=<B>&mode=
#   b. the access pane: /share-group-save with the page DIR path
#      (<base>/page/<name>) in peek, and make for edit
#   c. the Rune client: /share-group-save with <base>/page/<name>/code
#   d. a folder: /share-file on a folder, then a page inside it is read
#      (and written, for edit), and the access pane's way on a folder
#   e. MCP and Talon: lattice's MCP tools (plugins/claude/server.mjs,
#      plugins/hermes) have no share route, and Talon none in lattice:
#      sharing is the owner's. Nothing to test until one exists.
#
# After each share B's shared-with-me must list exactly one entry for it,
# ending /code for a page and /dir-index for a folder, at the mode given.
#
# Fake fleet ships only, never a real one. Cleans up after itself.
#
# Env:    A_URL, A_COOKIE, B_URL, B_COOKIE as two-ship-links.sh takes them.
# Prints one ok/FAIL line per check, exits non-zero on any FAIL.
set -uo pipefail

: "${A_URL:?A_URL}" "${A_COOKIE:?A_COOKIE}" "${B_URL:?B_URL}" "${B_COOKIE:?B_COOKIE}"
A="${A_URL%/}/apps/lattice"; B="${B_URL%/}/apps/lattice"
AK="Cookie: $(cat "$A_COOKIE")"; BK="Cookie: $(cat "$B_COOKIE")"
fails=0
ok()   { echo "ok    $1"; }
fail() { echo "FAIL  $1${2:+: $2}"; fails=$((fails+1)); }
is()   { if [ "$2" = "$3" ]; then ok "$1"; else fail "$1" "want [$2] got [$3]"; fi; }
A_()   { curl -s -m 90 -H "$AK" "$@"; }
B_()   { curl -s -m 90 -H "$BK" "$@"; }
enc()  { jq -rn --arg v "$1" '$v|@uri'; }
# until_ <secs> <cmd...>: until the command succeeds, once a second
until_() { local n=$1; shift; for _ in $(seq 1 "$n"); do "$@" && return 0; sleep 1; done; return 1; }

ASHIP=$(A_ "${A_URL%/}/~/host"); BSHIP=$(B_ "${B_URL%/}/~/host")
[ -n "$ASHIP" ] && [ -n "$BSHIP" ] || { echo "FAIL  ships answer /~/host"; exit 1; }
T="spaths$RANDOM"
BG=${BSHIP#\~}
SB=$(A_ "$A/streams" | jq -r .base)
[ -n "$SB" ] && [ "$SB" != null ] || { echo "FAIL  A's base from /streams"; exit 1; }

cleanup() {
  A_ -o /dev/null -X POST "$A/share-group-del?name=$BG"
  for n in a/r a/e b/r b/e c/r c/e d/p d g/p g; do
    A_ -o /dev/null -X POST "$A/page-del?name=$T/$n"
  done
  for n in a b c; do A_ -o /dev/null -X POST "$A/page-del?name=$T/$n"; done
  A_ -o /dev/null -X POST "$A/page-del?name=$T"
  B_ "$B/shared-with-me" | jq -r --arg h "$ASHIP" --arg t "/page/$T/" \
    '.[] | select(.host==$h and (.path|contains($t))) | .path' |
  while read -r pa; do
    B_ -o /dev/null -X POST -G --data-urlencode "host=$ASHIP" --data-urlencode "path=$pa" "$B/shared-with-me-del"
  done
}
trap cleanup EXIT

# --- what B sees ---
code_of() { echo "$SB/page/$T/$1/code"; }
# body <name>: the page's text as B's reader gets it, or nothing
body() { B_ -G --data-urlencode "ship=$ASHIP" --data-urlencode "path=$(code_of "$1")" "$B/browse-file" | jq -r '.body // empty' 2>/dev/null; }
status() { curl -s -m 90 -o /dev/null -w '%{http_code}' -H "$BK" -G --data-urlencode "ship=$ASHIP" --data-urlencode "path=$(code_of "$1")" "$B/browse-file"; }
reads() { [ "$(body "$1")" = "$2" ]; }
denied() { [ "$(status "$1")" != 200 ]; }
urb() { B_ -G --data-urlencode "url=urb://$ASHIP/$T/$1" "$B/urb-read"; }
urb_has() { urb "$1" | grep -qF -- "$2"; }
# swm <prefix>: B's shared-with-me entries from A under <base>/page/$T/<prefix>, as "path mode"
swm() { B_ "$B/shared-with-me" | jq -r --arg h "$ASHIP" --arg p "$SB/page/$T/$1" \
  '.[] | select(.host==$h and (.path|startswith($p))) | "\(.path) \(.mode)"' | sort; }
swm_is() { [ "$(swm "$1")" = "$2" ]; }
swm_none() { [ -z "$(swm "$1")" ]; }

# --- what A does ---
mkpage() { A_ -o /dev/null -w '%{http_code}' -X POST "$A/page-save?name=$T/$1&type=md&new=1" --data-binary "$2"; }
atext() { A_ "$A/page-source?name=$T/$1" | jq -r '.body // empty'; }
share() { A_ -X POST "$A/share-file?name=$T/$1&ship=$BSHIP&mode=$2"; }
unshare() { A_ -X POST "$A/unshare-file?name=$T/$1&ship=$BSHIP"; }
# grant <path> <read|edit|none>: A's group for B, read, changed on one path
# and saved whole, as the access pane and Rune both do
grant() {
  local g; g=$(A_ "$A/share-groups" | jq -c --arg g "$BG" '[.[] | select(.name==$g)][0] // {ships: [], peek: [], make: []}')
  g=$(jq -c --arg p "$1" --arg m "$2" --arg b "$BSHIP" '{
    ships: ((.ships + [$b]) | unique),
    peek: ((.peek - [$p]) + (if $m != "none" then [$p] else [] end)),
    make: ((.make - [$p]) + (if $m == "edit" then [$p] else [] end))}' <<<"$g")
  A_ -X POST "$A/share-group-save?name=$BG" --data-binary "$g"
}

# --- the checks ---
# reads_ok <label> <name> <text>: B reads it, both ways. Once the grant
# has had a minute to land, a second reader that fails is asked once, so a
# share that grants nothing fails in a minute, not in the gate's timeout
reads_ok() {
  local n=60
  if until_ 60 reads "$2" "$3"; then ok "$1: B reads it (browse-file)"
  else fail "$1: B reads it (browse-file)" "status $(status "$2"), body [$(body "$2" | head -c 80)]"; n=1; fi
  if until_ "$n" urb_has "$2" "$3"; then ok "$1: B reads it (urb-read)"
  else fail "$1: B reads it (urb-read)" "$(urb "$2" | head -c 200)"; fi
}
# listed_ok <label> <prefix> <want>: B lists exactly <want> under <prefix>
listed_ok() {
  if until_ 60 swm_is "$2" "$3"; then ok "$1: B lists $(basename "${3%% *}") ${3##* }, nothing else"
  else fail "$1: B lists exactly [$3]" "B lists [$(swm "$2" | tr '\n' ';')]"; fi
}
# writes_ok <label> <name> <text>: B saves it and A has B's text
writes_ok() {
  local rev out
  rev=$(B_ -G --data-urlencode "ship=$ASHIP" --data-urlencode "path=$(code_of "$2")" "$B/browse-file" | jq -r '.rev // empty')
  out=$(B_ -X POST "$B/remote-save?ship=$(enc "$ASHIP")&path=$(enc "$(code_of "$2")")${rev:+&base=$rev}" --data-binary "$3")
  local got n=30; got=$(jq -r '.outcome // empty' <<<"$out" 2>/dev/null || echo "$out")
  is "$1: B's remote-save lands" landed "$got"
  [ "$got" = landed ] || n=1   # nothing is coming: do not wait for it
  saved() { [ "$(atext "$2")" = "$3" ]; }
  if until_ "$n" saved "$1" "$2" "$3"; then ok "$1: A has B's text"; else fail "$1: A has B's text" "A has [$(atext "$2" | head -c 80)]"; fi
  if until_ "$n" reads "$2" "$3"; then ok "$1: B reads its own edit back"; else fail "$1: B reads its own edit back"; fi
}
# no_write <label> <name>: B's remote-save of a page shared for read does not land
no_write() {
  local out
  out=$(B_ -X POST "$B/remote-save?ship=$(enc "$ASHIP")&path=$(enc "$(code_of "$2")")" --data-binary "# not B's to write")
  if [ "$(jq -r '.outcome // empty' <<<"$out" 2>/dev/null)" = landed ]; then fail "$1: B cannot write it" "$out"
  else ok "$1: B cannot write it"; fi
  is "$1: A's text is unchanged" "$3" "$(atext "$2")"
}
# gone_ok <label> <name> <prefix>: after an unshare, B's read fails and its entry leaves
gone_ok() {
  if until_ 60 denied "$2"; then ok "$1: B's read fails"; else fail "$1: B's read fails" "B still reads [$(body "$2" | head -c 80)]"; fi
  if until_ 60 swm_none "$3"; then ok "$1: B's entry leaves"; else fail "$1: B's entry leaves" "B lists [$(swm "$3" | tr '\n' ';')]"; fi
}

# a page shared one way, read and edit: <case> <how> <mode>
# how: file (share-file), dir (group, the page's dir path), code (group, its code path)
page_case() {
  local c=$1 how=$2 m=$3 n="$1/${3:0:1}" tx="# $1 $3 by $ASHIP" label path r
  label="$c. $how $m"
  is "$label: A makes $T/$n" 200 "$(mkpage "$n" "$tx")"
  case $how in
    file) r=$(share "$n" "$m"); is "$label: share-file answers ok" true "$(jq -r .ok <<<"$r" 2>/dev/null)" ;;
    dir)  path="$SB/page/$T/$n" ;;&
    code) path=$(code_of "$n") ;;&
    dir|code) r=$(grant "$path" "$m"); grep -q '"ok"' <<<"$r" && ok "$label: share-group-save answers ok" || fail "$label: share-group-save answers ok" "$r" ;;
  esac
  listed_ok "$label" "$n/" "$(code_of "$n") $m"
  reads_ok "$label" "$n" "$tx"
  if [ "$m" = edit ]; then writes_ok "$label" "$n" "# $c edited by $BSHIP"
  else no_write "$label" "$n" "$tx"; fi
  case $how in
    file) unshare "$n" >/dev/null ;;
    *)    r=$(grant "$path" none); grep -q '"ok"' <<<"$r" || fail "$label: the unshare saves" "$r" ;;
  esac
  gone_ok "$label unshared" "$n" "$n/"
}

echo "==> a. the web share box (share-file)"
page_case a file read
page_case a file edit
echo "==> b. the access pane (share-group-save, the page's dir path)"
page_case b dir read
page_case b dir edit
echo "==> c. the Rune client (share-group-save, the page's code path)"
page_case c code read
page_case c code edit

echo "==> d. a folder (share-file), and a page in it"
is "d: A makes $T/d/p" 200 "$(mkpage d/p "# d page by $ASHIP")"
r=$(share d read)
grep -q '"folder":true' <<<"$r" && ok "d. folder read: share-file answers as a folder" || fail "d. folder read: share-file answers as a folder" "$r"
listed_ok "d. folder read" "d/" "$SB/page/$T/d/dir-index read"
reads_ok "d. folder read, its page" d/p "# d page by $ASHIP"
no_write "d. folder read, its page" d/p "# d page by $ASHIP"
r=$(share d edit)
listed_ok "d. folder edit" "d/" "$SB/page/$T/d/dir-index edit"
writes_ok "d. folder edit, its page" d/p "# d edited by $BSHIP"
unshare d >/dev/null
gone_ok "d. folder unshared, its page" d/p "d/"

echo "==> d. a folder by the access pane (share-group-save, the folder's path)"
is "d: A makes $T/g/p" 200 "$(mkpage g/p "# g page by $ASHIP")"
r=$(grant "$SB/page/$T/g" edit)
grep -q '"ok"' <<<"$r" && ok "d. group folder edit: share-group-save answers ok" || fail "d. group folder edit: share-group-save answers ok" "$r"
listed_ok "d. group folder edit" "g/" "$SB/page/$T/g/dir-index edit"
reads_ok "d. group folder edit, its page" g/p "# g page by $ASHIP"
writes_ok "d. group folder edit, its page" g/p "# g edited by $BSHIP"
r=$(grant "$SB/page/$T/g" none)
grep -q '"ok"' <<<"$r" || fail "d. group folder: the unshare saves" "$r"
gone_ok "d. group folder unshared, its page" g/p "g/"

echo "==> no bogus entry anywhere under $T"
bogus() { B_ "$B/shared-with-me" | jq -r --arg h "$ASHIP" --arg p "$SB/page/$T/" \
  '.[] | select(.host==$h and (.path|startswith($p))) | .path'; }
is "B lists nothing of $T once all is unshared" "" "$(bogus | tr '\n' ' ')"

[ "$fails" -eq 0 ] && echo "two-ship-share-paths: all passed" || echo "two-ship-share-paths: $fails failed"
[ "$fails" -eq 0 ]
