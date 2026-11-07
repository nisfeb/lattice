#!/usr/bin/env bash
# Two-ship check for shares sent back to back (lattice wiki
# reports/2026-11-06-share-notice-race). A shares several pages with B at
# once: 2 in parallel, 5 in parallel, then 5 in quick succession. Every
# page must land in B's shared with me, and A's grant group for B must
# hold every page. The inbox (/shares.sig) is one fiber and grubbery
# queues a notice that lands mid-apply, so none is lost. This guards
# that. Fake fleet ships only, never a real one.
# Cleans up after itself.
#
# Env:    A_URL, A_COOKIE, B_URL, B_COOKIE as two-ship-links.sh takes them,
#         ROUNDS (default 2).
# Prints one ok/FAIL line per check, exits non-zero on any FAIL.
set -uo pipefail

: "${A_URL:?A_URL}" "${A_COOKIE:?A_COOKIE}" "${B_URL:?B_URL}" "${B_COOKIE:?B_COOKIE}"
A="${A_URL%/}/apps/lattice"; B="${B_URL%/}/apps/lattice"
AK="Cookie: $(cat "$A_COOKIE")"; BK="Cookie: $(cat "$B_COOKIE")"
ROUNDS=${ROUNDS:-2}
fails=0
ok()   { echo "ok    $1"; }
fail() { echo "FAIL  $1${2:+: $2}"; fails=$((fails+1)); }
A_()   { curl -s -m 60 -H "$AK" "$@"; }
B_()   { curl -s -m 60 -H "$BK" "$@"; }

ASHIP=$(curl -s -m 30 -H "$AK" "${A_URL%/}/~/host")
BSHIP=$(curl -s -m 30 -H "$BK" "${B_URL%/}/~/host")
[ -n "$ASHIP" ] && [ -n "$BSHIP" ] || { echo "FAIL  ships answer /~/host"; exit 1; }
T="race$RANDOM"
PAGES=()

cleanup() {
  A_ -o /dev/null -X POST "$A/share-group-del?name=${BSHIP#\~}"
  for p in "${PAGES[@]}"; do A_ -o /dev/null -X POST "$A/page-del?name=$p"; done
  A_ -o /dev/null -X POST "$A/page-del?name=$T"
  B_ "$B/shared-with-me" | jq -r --arg h "$ASHIP" --arg t "/page/$T/" \
    '.[] | select(.host==$h and (.path|contains($t))) | .path' |
  while read -r pa; do
    B_ -o /dev/null -X POST -G --data-urlencode "host=$ASHIP" --data-urlencode "path=$pa" "$B/shared-with-me-del"
  done
}
trap cleanup EXIT

mk()    { A_ -o /dev/null -X POST "$A/page-save?name=$1&type=md&new=1" --data-binary "# $1"; PAGES+=("$1"); }
share() { A_ -o /dev/null -X POST "$A/share-file?name=$1&ship=$BSHIP&mode=read"; }
# missing <names...>: the names not (yet) in B's shared with me
missing() {
  local have; have=$(B_ "$B/shared-with-me" | jq -r --arg h "$ASHIP" '.[] | select(.host==$h) | .path')
  for n in "$@"; do grep -qx ".*/page/$n/code" <<<"$have" || echo "$n"; done
}
# ungranted <names...>: the names whose code grub A's group for B lacks
ungranted() {
  local peek; peek=$(A_ "$A/share-groups" | jq -r --arg g "${BSHIP#\~}" '.[] | select(.name==$g) | .peek[]')
  for n in "$@"; do grep -qxE ".*/page/$n(/code)?" <<<"$peek" || echo "$n"; done
}
# check <label> <names...>: wait up to 60 s for every name to land on B
check() {
  local label=$1; shift
  local miss
  for _ in $(seq 1 60); do
    miss=$(missing "$@")
    [ -z "$miss" ] && break
    sleep 1
  done
  if [ -z "$miss" ]; then ok "$label: all $# in B's shared with me"
  else fail "$label: all $# in B's shared with me" "missing $(echo $miss)"; fi
  miss=$(ungranted "$@")
  if [ -z "$miss" ]; then ok "$label: all $# granted"
  else fail "$label: all $# granted" "ungranted $(echo $miss)"; fi
}

A_ -o /dev/null -X POST "$A/page-save?name=$T&type=md&new=1" --data-binary "# $T"
for r in $(seq 1 "$ROUNDS"); do
  echo "==> round $r"
  two=() five=() seq5=()
  for i in 1 2; do two+=("$T/r$r-p2-$i"); done
  for i in 1 2 3 4 5; do five+=("$T/r$r-p5-$i"); seq5+=("$T/r$r-s5-$i"); done
  for n in "${two[@]}" "${five[@]}" "${seq5[@]}"; do mk "$n"; done
  for n in "${two[@]}"; do share "$n" & done; wait
  check "round $r, 2 in parallel" "${two[@]}"
  for n in "${five[@]}"; do share "$n" & done; wait
  check "round $r, 5 in parallel" "${five[@]}"
  for n in "${seq5[@]}"; do share "$n"; done
  check "round $r, 5 in succession" "${seq5[@]}"
done

[ "$fails" -eq 0 ] && echo "two-ship-share-race: all passed" || echo "two-ship-share-race: $fails failed"
[ "$fails" -eq 0 ]
