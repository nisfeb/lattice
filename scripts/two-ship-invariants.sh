#!/usr/bin/env bash
# Two-ship checks for the sharing invariants (lattice wiki
# reports/2026-11-07-lattice-unenforced-invariants, area share):
#
#   1. sensitive pages and folder grants: a folder shared with B never
#      grants B a sensitive page, nor lists it in the folder's index;
#      a page made in the folder and marked sensitive loses B's grant;
#      a page shared by hand keeps it when marked, and the answer warns
#   3. a ban strips a banned planet's moons and, for "comets", every
#      comet from a group, and B hears a %del for what it loses
#   4. a ban racing a share: no banned ship is left in a group
#   6. B's shared with me takes at most 500 entries from one host, and
#      drops a notice whose path is too long
#   7. a revoke sent while B is down still reaches B once it is up
#
# Fake fleet ships only, never a real one. Cleans up after itself.
#
# Env:    A_URL, A_COOKIE, B_URL, B_COOKIE as two-ship-links.sh takes
#         them; A_SOCK (A's pier is found from it), VERE, and B_SET (the
#         fleet set of B, for item 7; skipped without it).
# Prints one ok/FAIL line per check, exits non-zero on any FAIL.
set -uo pipefail

: "${A_URL:?A_URL}" "${A_COOKIE:?A_COOKIE}" "${B_URL:?B_URL}" "${B_COOKIE:?B_COOKIE}"
A="${A_URL%/}/apps/lattice"; B="${B_URL%/}/apps/lattice"
AK="Cookie: $(cat "$A_COOKIE")"; BK="Cookie: $(cat "$B_COOKIE")"
F=${FLEET:-$HOME/software/personal/hoon-development/fleet/fleet}
fails=0
ok()   { echo "ok    $1"; }
fail() { echo "FAIL  $1${2:+: $2}"; fails=$((fails+1)); }
A_()   { curl -s -m 60 -H "$AK" "$@"; }
B_()   { curl -s -m 60 -H "$BK" "$@"; }

ASHIP=$(curl -s -m 30 -H "$AK" "${A_URL%/}/~/host")
BSHIP=$(curl -s -m 30 -H "$BK" "${B_URL%/}/~/host")
[ -n "$ASHIP" ] && [ -n "$BSHIP" ] || { echo "FAIL  ships answer /~/host"; exit 1; }
T="inv$RANDOM"
BG=${BSHIP#\~}
MOON='~doznec-dozzod-doznec'            # a moon of ~nec
COMET='~doznec--dozzod-dozzod-dozzod-doznec--dozzod-dozzod-dozzod-dozzod'

cleanup() {
  A_ -o /dev/null -X POST "$A/unban?ship=$BSHIP"
  A_ -o /dev/null -X POST "$A/unban?ship=~nec"
  A_ -o /dev/null -X POST "$A/unban?ship=comets"
  A_ -o /dev/null -X POST "$A/share-group-del?name=$BG"
  A_ -o /dev/null -X POST "$A/share-group-del?name=inv-fam"
  for n in f/p f/s f/n f/h f r/p r m/p m; do
    A_ -o /dev/null -X POST "$A/page-del?name=$T/$n"
  done
  A_ -o /dev/null -X POST "$A/page-del?name=$T"
  B_ "$B/shared-with-me" | jq -r --arg h "$ASHIP" '.[] | select(.host==$h) | .path' |
  while read -r pa; do
    B_ -o /dev/null -X POST -G --data-urlencode "host=$ASHIP" --data-urlencode "path=$pa" "$B/shared-with-me-del"
  done
}
trap cleanup EXIT

swm() { B_ "$B/shared-with-me" | jq -r --arg h "$ASHIP" '.[] | select(.host==$h) | .path'; }
mode() { A_ "$A/share-groups" | jq -r --arg g "$BG" --arg t "/page/$T/$1" '
  [.[] | select(.name==$g)][0] // {peek: [], make: []} |
  if (.make | any(endswith($t))) then "edit"
  elif (.peek | any(endswith($t))) then "read" else "none" end'; }
is-mode() { local m; m=$(mode "$1")
  [ "$m" = "$2" ] && ok "$3" || fail "$3" "B holds it for $m, not $2"; }
wait-for() {
  local label=$1 secs=$2; shift 2
  for _ in $(seq 1 "$secs"); do "$@" && { ok "$label"; return; }; sleep 1; done
  fail "$label"
}
listed()   { swm | grep -qx ".*/page/$T/$1"; }
unlisted() { ! listed "$1"; }
mkpage()   { A_ -o /dev/null -X POST "$A/page-save?name=$T/$1&type=md&new=1" --data-binary "# $2"; }
share()    { A_ -X POST "$A/share-file?name=$T/$1&ship=$BSHIP&mode=$2"; }
members()  { A_ "$A/share-groups" | jq -r --arg g "$1" '.[] | select(.name==$g) | .ships[]'; }

# --- 1. sensitive pages and folder grants ---------------------------------
mkpage f/p "Plain page"
mkpage f/s "Secret title"
A_ -o /dev/null -X POST "$A/page-sensitive?name=$T/f/s&on=1"
share f read >/dev/null
wait-for "1: folder shared, listed on B" 60 listed f/dir-index
is-mode f/p read "1: folder share grants the plain page"
is-mode f/s none "1: folder share does not grant the sensitive page"
# the index A keeps for B, read as A's own file
abs=$(A_ "$A/share-groups" | jq -r --arg g "$BG" --arg t "/page/$T/f/dir-index" \
  '.[] | select(.name==$g) | .peek[] | select(endswith($t))' | head -1)
if [ -n "$abs" ]; then
  body=$(A_ -G --data-urlencode "ship=$ASHIP" --data-urlencode "path=$abs" "$A/browse-file")
  grep -q "Plain page" <<<"$body" && ok "1: the index lists the plain page" ||
    fail "1: the index lists the plain page" "${body:0:200}"
  grep -q "Secret title\|/$T/f/s" <<<"$body" && fail "1: the index omits the sensitive page" "${body:0:300}" ||
    ok "1: the index omits the sensitive page"
else
  fail "1: B holds the folder's index road"
fi
# a page made in the shared folder, then marked sensitive, loses B's grant
mkpage f/n "New page"
for _ in $(seq 1 30); do [ "$(mode f/n)" = read ] && break; sleep 1; done
is-mode f/n read "1: a new page in the shared folder is granted"
A_ -o /dev/null -X POST "$A/page-sensitive?name=$T/f/n&on=1"
for _ in $(seq 1 30); do [ "$(mode f/n)" = none ] && break; sleep 1; done
is-mode f/n none "1: marking it sensitive takes back the folder's grant"
# a page shared by hand keeps its own share when marked, and is warned of
mkpage f/h "Hand page"
share f/h edit >/dev/null
r=$(A_ -X POST "$A/page-sensitive?name=$T/f/h&on=1")
jq -e '.shared == true' <<<"$r" >/dev/null && ok "1: marking a hand-shared page warns it is shared" ||
  fail "1: marking a hand-shared page warns it is shared" "$r"
sleep 2
is-mode f/h edit "1: the page's own share stays"
# unmarking gives the folder's grant back
A_ -o /dev/null -X POST "$A/page-sensitive?name=$T/f/n&on=0"
for _ in $(seq 1 30); do [ "$(mode f/n)" = read ] && break; sleep 1; done
is-mode f/n read "1: unmarking gives the folder's grant back"

# --- 3. a ban strips the family -------------------------------------------
mkpage m/p "Family page"
r=$(A_ -X POST "$A/share-group-save?name=inv-fam" --data-binary \
  "{\"ships\":[\"$MOON\",\"$COMET\",\"~bus\"],\"peek\":[],\"make\":[]}")
jq -e '.ok == true' <<<"$r" >/dev/null || fail "3: group with a moon and a comet saved" "$r"
A_ -o /dev/null -X POST "$A/ban?ship=~nec"
members inv-fam | grep -qx "$MOON" && fail "3: banning a planet strips its moon" ||
  ok "3: banning a planet strips its moon"
members inv-fam | grep -qx "$COMET" || fail "3: the comet stays until comets are banned"
A_ -o /dev/null -X POST "$A/ban?ship=comets"
members inv-fam | grep -qx "$COMET" && fail "3: banning comets strips every comet" ||
  ok "3: banning comets strips every comet"
members inv-fam | grep -qx "~bus" && ok "3: other members stay" || fail "3: other members stay"
# B is told of what a ban takes from it
share m/p read >/dev/null
wait-for "3: page shared, listed on B" 60 listed m/p/code
A_ -o /dev/null -X POST "$A/ban?ship=$BSHIP"
is-mode m/p none "3: a banned ship holds nothing"
wait-for "3: B hears the ban's %del" 60 unlisted m/p/code
A_ -o /dev/null -X POST "$A/unban?ship=$BSHIP"

# --- 4. a ban racing a share ----------------------------------------------
mkpage r/p "Race page"
for i in 1 2 3 4; do
  A_ -o /dev/null -X POST "$A/unban?ship=$BSHIP"
  share r/p read >/dev/null &
  A_ -o /dev/null -X POST "$A/ban?ship=$BSHIP" &
  share r/p edit >/dev/null &
  wait
  sleep 1
  members "$BG" | grep -qx "$BSHIP" && { fail "4: race $i leaves B out of its group"; continue; }
  ok "4: race $i leaves B out of its group"
done
A_ -o /dev/null -X POST "$A/unban?ship=$BSHIP"

# --- 6. B's per-host cap and path bound -----------------------------------
APIER=${A_SOCK%/.urb/*}
if [ -n "${A_SOCK:-}" ] && [ -d "$APIER" ] && [ -n "${VERE:-}" ]; then
  base="/apps/'shell.shell'/desks/'lattice.desk'/desk/data/'lattice.lattice_app'"
  # 520 notices from A, each a fresh page path, poked straight at B's inbox
  hoon="=/  m  (strand ,vase)
;<  =bowl  bind:m  get-bowl
=/  i=@ud  0
|-  ^-  form:m
?:  =(i 521)  (pure:m !>(%sent))
=/  pax=path  ?:(=(i 520) (weld /apps/x (reap 70 %a)) /apps/inv-cap/(scot %ud i)/code)
=/  req  [[/share-notice %& $base %'shares.sig'] [%poke [/lattice %share-notice] [%add pax 'read']]]
;<  ~  bind:m  (poke [$BSHIP %grubbery] %grubbery-load !>(req))
\$(i +(i))"
  # shellcheck disable=SC1090
  (source "$F" && khan "$VERE" "$APIER" "$hoon") >/dev/null 2>&1
  n=0
  for _ in $(seq 1 60); do
    n=$(B_ "$B/shared-with-me" | jq --arg h "$ASHIP" '[.[] | select(.host==$h)] | length')
    [ "${n:-0}" -ge 500 ] && break; sleep 1
  done
  [ "${n:-0}" -eq 500 ] && ok "6: one host holds at most 500 entries" ||
    fail "6: one host holds at most 500 entries" "B lists $n from A"
  B_ "$B/shared-with-me" | jq -e --arg h "$ASHIP" \
    '[.[] | select(.host==$h and (.path|startswith("/apps/x/")))] | length == 0' >/dev/null &&
    ok "6: a notice with a too long path is dropped" || fail "6: a notice with a too long path is dropped"
  B_ "$B/shared-with-me" | jq -r --arg h "$ASHIP" '.[] | select(.host==$h) | .path' |
  while read -r pa; do
    B_ -o /dev/null -X POST -G --data-urlencode "host=$ASHIP" --data-urlencode "path=$pa" "$B/shared-with-me-del"
  done
else
  fail "6: A's pier and VERE are known (A_SOCK, VERE)"
fi

# --- 7. a revoke while B is down ------------------------------------------
if [ -n "${B_SET:-}" ]; then
  share f/p read >/dev/null
  wait-for "7: page shared, listed on B" 60 listed f/p/code
  "$F" down "$B_SET" >/dev/null 2>&1
  A_ -o /dev/null -X POST "$A/unshare-file?name=$T/f/p&ship=$BSHIP"
  A_ -o /dev/null -X POST "$A/unshare-file?name=$T/f&ship=$BSHIP"
  sleep 25
  "$F" up "$B_SET" >/dev/null 2>&1
  for _ in $(seq 1 60); do curl -s -m 5 -o /dev/null "${B_URL%/}/~/host" && break; sleep 1; done
  wait-for "7: B, back up, hears the revoke" 180 unlisted f/p/code
else
  echo "skip  7: no B_SET"
fi

[ "$fails" -eq 0 ] && echo "all ok" || echo "$fails failed"
exit $(( fails > 0 ))
