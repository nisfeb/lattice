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
# Unsharing a folder leaves each grant that came from elsewhere, at the
# mode it was given (own-grants), as if the folder share never happened:
#   3. read under edit: P by hand for read, its folder for edit, the
#      folder unshared: B holds P for read, not edit
#   4. edit under read: P by hand for edit in a folder shared for read,
#      the folder unshared: B holds P for edit. A page in a shared folder
#      shared and unshared by hand keeps the folder's read
#   5. group under folder: P granted for read through the group panel
#      (share-group-save on A's group for B), its folder for edit, the
#      folder unshared: B holds P for read
#   6. move out: P by hand for read in a folder shared for edit, moved
#      out of it: B holds P where it lands, for read
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
  for n in f/p f/q f r/p r/q r e/p e/q e g/p g/q g m/q m out/p out; do
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

swm() { B_ "$B/shared-with-me" | jq -r --arg h "$ASHIP" '.[] | select(.host==$h) | .path'; }
# held <name>: A's group for B grants the page (its code road, listed
# by the page's path)
held() { A_ "$A/share-groups" | jq -e --arg g "$BG" --arg t "/page/$T/$1" \
  '.[] | select(.name==$g) | .peek | any(endswith($t))' >/dev/null; }
# mode <name>: what A's group for B grants the page: edit, read or none
mode() { A_ "$A/share-groups" | jq -r --arg g "$BG" --arg t "/page/$T/$1" '
  [.[] | select(.name==$g)][0] // {peek: [], make: []} |
  if (.make | any(endswith($t))) then "edit"
  elif (.peek | any(endswith($t))) then "read" else "none" end'; }
# is-mode <name> <mode> <label>: one check of mode
is-mode() { local m; m=$(mode "$1")
  [ "$m" = "$2" ] && ok "$3" || fail "$3" "B holds it for $m, not $2"; }
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

save() { A_ -X POST "$A/share-group-save?name=$BG" --data-binary "$1"; }
mk() { for n in p q; do
  A_ -o /dev/null -X POST "$A/page-save?name=$T/$1/$n&type=md&new=1" --data-binary "# $n"
done; }
share() { A_ -o /dev/null -X POST "$A/share-file?name=$T/$1&ship=$BSHIP&mode=$2"; }
unshare() { A_ -o /dev/null -X POST "$A/unshare-file?name=$T/$1&ship=$BSHIP"; }

# 3. read under edit
mk r
share r/p read
share r edit
is-mode r/p edit "read under edit: the folder gives P edit"
unshare r
wait-for "read under edit: folder entry leaves B" unlisted r/dir-index
is-mode r/p read "read under edit: B keeps P for read"
is-mode r/q none "read under edit: B no longer holds Q"
wait-for "read under edit: P listed on B as a page" listed r/p/code

# 4. edit under read, and a page unshared by hand under a shared folder
mk e
share e/p edit
share e read
is-mode e/q read "edit under read: the folder gives Q read"
share e/q edit
is-mode e/q edit "edit under read: Q shared by hand for edit"
unshare e/q
is-mode e/q read "page unshared under a shared folder: B keeps Q for read"
unshare e
wait-for "edit under read: folder entry leaves B" unlisted e/dir-index
is-mode e/p edit "edit under read: B keeps P for edit"
is-mode e/q none "edit under read: B no longer holds Q"

# 5. group under folder
mk g
gj=$(A_ "$A/share-groups" | jq -c --arg g "$BG" '.[] | select(.name==$g)')
SB=$(jq -r '[.peek[] | select(contains("/page/"))][0] | sub("/page/.*$"; "")' <<<"$gj")
r=$(save "$(jq -c --arg p "$SB/page/$T/g/p" '{ships, peek: (.peek + [$p]), make}' <<<"$gj")")
grep -q '"ok"' <<<"$r" || fail "group under folder: panel grants P" "$r"
is-mode g/p read "group under folder: the panel gives P read"
share g edit
is-mode g/p edit "group under folder: the folder gives P edit"
unshare g
wait-for "group under folder: folder entry leaves B" unlisted g/dir-index
is-mode g/p read "group under folder: B keeps P for read"
is-mode g/q none "group under folder: B no longer holds Q"

# 6. move out of the folder
mk m
share m/p read
share m edit
is-mode m/p edit "move out: the folder gives P edit"
A_ -o /dev/null -X POST "$A/page-move?from=$T/m/p&to=$T/out/p"
moved() { [ "$(mode out/p)" != "none" ] || [ "$(mode m/p)" = "none" ]; }
for _ in $(seq 1 60); do moved && break; sleep 1; done
is-mode out/p read "move out: B holds P where it lands, for read"
is-mode m/p none "move out: no grant left at the old path"
is-mode m/q edit "move out: Q keeps the folder's edit"

[ "$fails" -eq 0 ] && echo "two-ship-hand-share: all passed" || echo "two-ship-hand-share: $fails failed"
[ "$fails" -eq 0 ]
