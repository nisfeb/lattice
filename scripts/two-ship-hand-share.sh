#!/usr/bin/env bash
# Two-ship check that a page shared by hand keeps its share when a folder
# around it is shared and then unshared (lattice wiki
# reports/2026-11-06-share-notice-race). The folder share used to note
# itself (grant-via) on every page under it, the hand-shared one too, so
# unsharing the folder took the page's own grant back.
#
#   1. A shares page P with B, then the folder F holding P and Q
#   2. A unshares F: B still holds P (A's group for B keeps P's code
#      road), P is listed in B's shared with me as a page, Q is not held
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
T="hshare$RANDOM"
BG=${BSHIP#\~}

cleanup() {
  A_ -o /dev/null -X POST "$A/share-group-del?name=$BG"
  for n in f/p f/q f; do A_ -o /dev/null -X POST "$A/page-del?name=$T/$n"; done
  A_ -o /dev/null -X POST "$A/page-del?name=$T"
  B_ "$B/shared-with-me" | jq -r --arg h "$ASHIP" --arg t "/page/$T/" \
    '.[] | select(.host==$h and (.path|contains($t))) | .path' |
  while read -r pa; do
    B_ -o /dev/null -X POST -G --data-urlencode "host=$ASHIP" --data-urlencode "path=$pa" "$B/shared-with-me-del"
  done
}
trap cleanup EXIT

swm() { B_ "$B/shared-with-me" | jq -r --arg h "$ASHIP" '.[] | select(.host==$h) | .path'; }
# held <name>: A's group for B grants the page (its code road, listed
# by the page's path)
held() { A_ "$A/share-groups" | jq -e --arg g "$BG" --arg t "/page/$T/$1" \
  '.[] | select(.name==$g) | .peek | any(endswith($t))' >/dev/null; }
# wait-for <label> <cmd...>: up to 60 s for the command to succeed
wait-for() {
  local label=$1; shift
  for _ in $(seq 1 60); do "$@" && { ok "$label"; return; }; sleep 1; done
  fail "$label" "B lists: $(swm | grep "/$T/" | tr '\n' ' ')"
}
listed()  { swm | grep -qx ".*/page/$T/$1"; }
unlisted() { ! listed "$1"; }

for n in p q; do
  A_ -o /dev/null -X POST "$A/page-save?name=$T/f/$n&type=md&new=1" --data-binary "# $n"
done

A_ -o /dev/null -X POST "$A/share-file?name=$T/f/p&ship=$BSHIP&mode=read"
wait-for "P shared by hand: listed on B" listed f/p/code
r=$(A_ -X POST "$A/share-file?name=$T/f&ship=$BSHIP&mode=read")
grep -q '"folder":true' <<<"$r" || fail "folder share answers as a folder" "$r"
wait-for "folder shared: listed on B" listed f/dir-index
held f/q && ok "folder shared: B holds Q" || fail "folder shared: B holds Q"

A_ -o /dev/null -X POST "$A/unshare-file?name=$T/f&ship=$BSHIP"
wait-for "folder unshared: its entry leaves B" unlisted f/dir-index
held f/p && ok "folder unshared: B still holds P" || fail "folder unshared: B still holds P"
held f/q && fail "folder unshared: B no longer holds Q" || ok "folder unshared: B no longer holds Q"
wait-for "folder unshared: P listed on B as a page" listed f/p/code

[ "$fails" -eq 0 ] && echo "two-ship-hand-share: all passed" || echo "two-ship-hand-share: $fails failed"
[ "$fails" -eq 0 ]
