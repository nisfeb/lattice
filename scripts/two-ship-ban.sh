#!/usr/bin/env bash
# Two-ship check that a ban takes away everything and an unban gives back
# nothing. A ban used to take B out of its groups but leave the roads of
# A's group for B, so after an unban one share merged B back into that
# group and gave back every grant the ban took, untold.
#
#   1. A shares pages P and Q and the folder F (holding R) with B
#   2. A bans B: A's group for B is gone, and B drops all of them
#   3. while banned, A adds page N to F: no group for B comes back
#   4. A unbans B and shares page S: A's group for B holds S alone, B
#      lists S alone, and B reads no page of F
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
T="ban$RANDOM"
BG=${BSHIP#\~}

cleanup() {
  A_ -o /dev/null -X POST "$A/unban?ship=$BSHIP"
  A_ -o /dev/null -X POST "$A/share-group-del?name=$BG"
  for n in p q s f/r f/n f; do
    A_ -o /dev/null -X POST "$A/page-del?name=$T/$n"
  done
  A_ -o /dev/null -X POST "$A/page-del?name=$T"
  B_ "$B/shared-with-me" | jq -r --arg h "$ASHIP" --arg t "/page/$T/" \
    '.[] | select(.host==$h and (.path|contains($t))) | .path' |
  while read -r pa; do
    B_ -o /dev/null -X POST -G --data-urlencode "host=$ASHIP" --data-urlencode "path=$pa" "$B/shared-with-me-del"
  done
}
trap cleanup EXIT

# B's shared with me from A, under this run's tree
swm() { B_ "$B/shared-with-me" | jq -r --arg h "$ASHIP" --arg t "/page/$T/" \
  '.[] | select(.host==$h and (.path|contains($t))) | .path' | sort; }
# every road A's group for B holds, peek and make, or "none" with no group
roads() { A_ "$A/share-groups" | jq -r --arg g "$BG" '
  [.[] | select(.name==$g)][0] // null |
  if . == null then "none" else ((.peek + .make) | unique | .[]) end'; }
mkpage() { A_ -o /dev/null -X POST "$A/page-save?name=$T/$1&type=md&new=1" --data-binary "# $1"; }
share()  { A_ -o /dev/null -X POST "$A/share-file?name=$T/$1&ship=$BSHIP&mode=$2"; }
wait-for() {
  local label=$1 secs=$2; shift 2
  for _ in $(seq 1 "$secs"); do "$@" && { ok "$label"; return; }; sleep 1; done
  fail "$label"
}

# --- 1. shares ------------------------------------------------------------
mkpage p; mkpage q; mkpage s; mkpage f/r
share p read; share q edit; share f read
has-all() { local l; l=$(swm)
  grep -q "/page/$T/p/code$" <<<"$l" && grep -q "/page/$T/q/code$" <<<"$l" &&
  grep -q "/page/$T/f/dir-index$" <<<"$l"; }
wait-for "B lists P, Q and F" 30 has-all

# --- 2. ban ---------------------------------------------------------------
r=$(A_ -X POST "$A/ban?ship=$BSHIP")
[ "$(jq -r .ok <<<"$r")" = "true" ] && ok "the ban revokes" || fail "the ban revokes" "$r"
[ "$(roads)" = "none" ] && ok "A's group for B is gone" || fail "A's group for B is gone" "$(roads | tr '\n' ' ')"
none() { [ -z "$(swm)" ]; }
wait-for "B drops every page of A's" 60 none

# --- 3. a page added to F while B is banned -------------------------------
mkpage f/n
sleep 3
[ "$(roads)" = "none" ] && ok "a page added to F makes no group for B" \
  || fail "a page added to F makes no group for B" "$(roads | tr '\n' ' ')"

# --- 4. unban, then one share ---------------------------------------------
r=$(A_ -X POST "$A/unban?ship=$BSHIP")
[ "$(jq -r .ok <<<"$r")" = "true" ] && ok "the unban answers ok" || fail "the unban answers ok" "$r"
[ "$(roads)" = "none" ] && ok "the unban gives B no group" || fail "the unban gives B no group" "$(roads | tr '\n' ' ')"
share s read
got=$(roads | sed 's|.*/page/||')
[ "$got" = "$T/s" ] && ok "A's group for B holds S alone" \
  || fail "A's group for B holds S alone" "$(tr '\n' ' ' <<<"$got")"
only-s() { [ "$(swm)" = "$(swm | grep "/page/$T/s/code$")" ] && [ -n "$(swm)" ]; }
wait-for "B lists S alone" 30 only-s
[ -z "$(swm | grep -v "/page/$T/s/code$")" ] || fail "B lists nothing but S" "$(swm | tr '\n' ' ')"
n=$(B_ -G --data-urlencode "host=$ASHIP" --data-urlencode "path=/$T/f" "$B/folder-pages" | jq 'if type=="array" then length else 0 end' 2>/dev/null)
[ "${n:-0}" = "0" ] && ok "B reads no page of F" || fail "B reads no page of F" "$n pages"

[ "$fails" = 0 ] && echo "PASS two-ship-ban" || echo "FAIL two-ship-ban ($fails)"
exit $((fails > 0))
