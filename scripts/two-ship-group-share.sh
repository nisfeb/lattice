#!/usr/bin/env bash
# Two-ship check that every grant tells the ship it reaches, and every
# revoke tells the ship it leaves (lattice wiki
# reports/2026-11-06-share-notice-race). A grant made through a group
# (share-group-save) and a folder share used to send no share notice, so
# the page was readable but missing from B's shared with me.
#
#   1. a page added to B's group lands in B's shared with me, and the page
#      B already had is not told again
#   2. a folder of 3 pages shared with B lands as its 3 pages
#   3. B added to a group that already holds 2 pages gets both
#   4. each revoke (a page out of the group, B out of the group, the folder
#      unshared) takes its pages off B's shared with me
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
A_()   { curl -s -m 60 -H "$AK" "$@"; }
B_()   { curl -s -m 60 -H "$BK" "$@"; }

ASHIP=$(curl -s -m 30 -H "$AK" "${A_URL%/}/~/host")
BSHIP=$(curl -s -m 30 -H "$BK" "${B_URL%/}/~/host")
[ -n "$ASHIP" ] && [ -n "$BSHIP" ] || { echo "FAIL  ships answer /~/host"; exit 1; }
T="gshare$RANDOM"
BG=${BSHIP#\~}
GX="gx$RANDOM"

cleanup() {
  A_ -o /dev/null -X POST "$A/share-group-del?name=$BG"
  A_ -o /dev/null -X POST "$A/share-group-del?name=$GX"
  for n in g1 g2 f/a f/b f/sub/c h1 h2; do A_ -o /dev/null -X POST "$A/page-del?name=$T/$n"; done
  A_ -o /dev/null -X POST "$A/page-del?name=$T"
  B_ "$B/shared-with-me" | jq -r --arg h "$ASHIP" --arg t "/page/$T/" \
    '.[] | select(.host==$h and (.path|contains($t))) | .path' |
  while read -r pa; do
    B_ -o /dev/null -X POST -G --data-urlencode "host=$ASHIP" --data-urlencode "path=$pa" "$B/shared-with-me-del"
  done
}
trap cleanup EXIT

mk() { A_ -o /dev/null -X POST "$A/page-save?name=$1&type=md&new=1" --data-binary "# $1"; }
# swm: the paths of A's pages in B's shared with me
swm() { B_ "$B/shared-with-me" | jq -r --arg h "$ASHIP" '.[] | select(.host==$h) | .path'; }
# wait-in <label> <names...>: up to 60 s for every name to be on B
wait-in() {
  local label=$1; shift
  local miss have
  for _ in $(seq 1 60); do
    have=$(swm); miss=""
    for n in "$@"; do grep -qx ".*/page/$n/code" <<<"$have" || miss="$miss $n"; done
    [ -z "$miss" ] && break
    sleep 1
  done
  if [ -z "$miss" ]; then ok "$label"; else fail "$label" "missing$miss"; fi
}
# wait-out <label> <names...>: up to 60 s for every name to leave B
wait-out() {
  local label=$1; shift
  local left have
  for _ in $(seq 1 60); do
    have=$(swm); left=""
    for n in "$@"; do grep -qx ".*/page/$n/code" <<<"$have" && left="$left $n"; done
    [ -z "$left" ] && break
    sleep 1
  done
  if [ -z "$left" ]; then ok "$label"; else fail "$label" "still there:$left"; fi
}
group() { A_ "$A/share-groups" | jq -c --arg g "$1" '.[] | select(.name==$g)'; }
save()  { A_ -X POST "$A/share-group-save?name=$1" --data-binary "$2"; }

for n in g1 g2 f/a f/b f/sub/c h1 h2; do mk "$T/$n"; done

# ── 1. a page added to B's own group ──
A_ -o /dev/null -X POST "$A/share-file?name=$T/g1&ship=$BSHIP&mode=read"
wait-in "share-file: g1 on B" "$T/g1"
g=$(group "$BG")
SB=$(jq -r --arg t "/page/$T/g1" '.peek[] | select(endswith($t)) | sub("/page/.*$"; "")' <<<"$g")
[ -n "$SB" ] || { fail "A's base from B's group" "$g"; exit 1; }
when1=$(B_ "$B/shared-with-me" | jq -r --arg t "/page/$T/g1/code" '.[] | select(.path|endswith($t)) | .when')
r=$(save "$BG" "$(jq -c --arg p "$SB/page/$T/g2" '{ships, peek: (.peek + [$p]), make}' <<<"$g")")
grep -q '"ok"' <<<"$r" || fail "group save adds g2" "$r"
wait-in "group grant: g2 on B" "$T/g2"
when1b=$(B_ "$B/shared-with-me" | jq -r --arg t "/page/$T/g1/code" '.[] | select(.path|endswith($t)) | .when')
[ "$when1" = "$when1b" ] && ok "group grant: g1, held already, not told again" \
  || fail "group grant: g1, held already, not told again" "$when1 then $when1b"

# ── 2. a folder of 3 pages ──
r=$(A_ -X POST "$A/share-file?name=$T/f&ship=$BSHIP&mode=read")
grep -q '"folder":true' <<<"$r" || fail "folder share answers as a folder" "$r"
wait-in "folder share: its 3 pages on B" "$T/f/a" "$T/f/b" "$T/f/sub/c"

# ── 3. B added to a group that holds 2 pages ──
r=$(save "$GX" "$(jq -nc --arg a "$SB/page/$T/h1" --arg b "$SB/page/$T/h2" '{ships: [], peek: [$a, $b], make: []}')")
grep -q '"ok"' <<<"$r" || fail "group $GX made with 2 pages" "$r"
r=$(save "$GX" "$(jq -nc --arg s "$BSHIP" --arg a "$SB/page/$T/h1" --arg b "$SB/page/$T/h2" '{ships: [$s], peek: [$a, $b], make: []}')")
grep -q '"ok"' <<<"$r" || fail "B added to $GX" "$r"
wait-in "B added to a group: h1 and h2 on B" "$T/h1" "$T/h2"

# ── 4. the revokes ──
g=$(group "$BG")
r=$(save "$BG" "$(jq -c --arg p "$SB/page/$T/g2" '{ships, peek: [.peek[] | select(. != $p)], make}' <<<"$g")")
grep -q '"ok"' <<<"$r" || fail "g2 out of B's group" "$r"
wait-out "page out of the group: g2 leaves B" "$T/g2"
wait-in "page out of the group: g1 stays on B" "$T/g1"
r=$(save "$GX" "$(jq -nc --arg a "$SB/page/$T/h1" --arg b "$SB/page/$T/h2" '{ships: [], peek: [$a, $b], make: []}')")
grep -q '"ok"' <<<"$r" || fail "B out of $GX" "$r"
wait-out "B out of the group: h1 and h2 leave B" "$T/h1" "$T/h2"
A_ -o /dev/null -X POST "$A/unshare-file?name=$T/f&ship=$BSHIP"
wait-out "folder unshared: its 3 pages leave B" "$T/f/a" "$T/f/b" "$T/f/sub/c"
wait-in "folder unshared: g1 stays on B" "$T/g1"

[ "$fails" -eq 0 ] && echo "two-ship-group-share: all passed" || echo "two-ship-group-share: $fails failed"
[ "$fails" -eq 0 ]
