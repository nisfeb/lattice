#!/usr/bin/env bash
# Two-ship check that a page unpublished and published again reaches a
# watcher with its new text, never the old. Ship A publishes a page, ship B
# subscribes and reads it, A unpublishes it, edits it, and publishes it
# again. A's revision list must name a higher revision under a new id, and
# every read B makes from then on must show the new text or nothing, and
# end on the new text. Fake fleet ships only, never a real one.
#
# Usage:  scripts/two-ship-republish.sh
# Env:    A_URL, A_COOKIE, B_URL, B_COOKIE as in scripts/two-ship-links.sh.
#
# Before the per-name revision offset, the publish again came back at
# revision 1, the id the unpublish culled: gall never read the new grow
# there, and A's runtime kept serving the old text at that id.
set -uo pipefail

: "${A_URL:?A_URL}" "${A_COOKIE:?A_COOKIE}" "${B_URL:?B_URL}" "${B_COOKIE:?B_COOKIE}"
A="${A_URL%/}/apps/lattice"; B="${B_URL%/}/apps/lattice"
AK="Cookie: $(cat "$A_COOKIE")"; BK="Cookie: $(cat "$B_COOKIE")"
DATA=/grubbery/api/file/apps/shell.shell/desks/lattice.desk/desk/data/lattice.lattice_app
fails=0

ok()   { echo "ok    $1"; }
fail() { echo "FAIL  $1${2:+: $2}"; fails=$((fails+1)); }
is()   { if [ "$2" = "$3" ]; then ok "$1"; else fail "$1" "want [$2] got [$3]"; fi; }
A_()   { curl -s -m 60 -H "$AK" "$@"; }
B_()   { curl -s -m 60 -H "$BK" "$@"; }
code() { curl -s -m 60 -o /dev/null -w '%{http_code}' "$@"; }

ASHIP=$(A_ "${A_URL%/}/~/host"); BSHIP=$(B_ "${B_URL%/}/~/host")
[ -n "$ASHIP" ] && [ -n "$BSHIP" ] || { echo "FAIL  ships answer /~/host"; exit 1; }

P=repub$$
NAME=$P/page   # not x/: urb://~ship/x/ is the explorer
URL="urb://$ASHIP/$NAME"
OLD="old words $P"; NEW="new words $P"
cleanup() {
  B_ -o /dev/null -X POST --data-urlencode "url=$URL" -G "$B/unsub"
  A_ -o /dev/null -X POST "$A/page-share?name=$NAME&mode=private"
  A_ -o /dev/null -X POST "$A/page-del?name=$P"
}
trap cleanup EXIT

row() { A_ "${A_URL%/}$DATA/pub/revs" | jq -c --arg n "/$NAME" '.[$n] // empty'; }
read_() { B_ -G --data-urlencode "url=$URL" "$B/urb-read"; }
waitrow() { for _ in $(seq 1 60); do r=$(row); [ -n "$r" ] && { echo "$r"; return; }; sleep 1; done; }

echo "==> A publishes $NAME, B watches it"
is "A makes the page" 200 "$(code -H "$AK" -X POST "$A/page-save?name=$NAME&type=md&new=1" --data-binary "# $OLD")"
is "A publishes it" 200 "$(code -H "$AK" -X POST "$A/page-share?name=$NAME&mode=shared")"
r1=$(waitrow)
[ -n "$r1" ] && ok "A lists it ($r1)" || fail "A lists it"
is "B subscribes" 200 "$(code -H "$BK" -X POST --data-urlencode "url=$URL" -G "$B/sub")"
got=
for _ in $(seq 1 60); do got=$(read_); grep -qF "$OLD" <<<"$got" && break; sleep 1; done
grep -qF "$OLD" <<<"$got" && ok "B reads the old text" || fail "B reads the old text" "$(head -c 300 <<<"$got")"

echo "==> A unpublishes, edits, and publishes again"
is "A unpublishes" 200 "$(code -H "$AK" -X POST "$A/page-share?name=$NAME&mode=private")"
for _ in $(seq 1 60); do [ -z "$(row)" ] && break; sleep 1; done
is "  ...it leaves the list" "" "$(row)"
is "A edits the page" 200 "$(code -H "$AK" -X POST "$A/page-save?name=$NAME&type=md" --data-binary "# $NEW")"
is "A publishes it again" 200 "$(code -H "$AK" -X POST "$A/page-share?name=$NAME&mode=shared")"
r2=$(waitrow)
[ -n "$r2" ] && ok "A lists it again ($r2)" || fail "A lists it again"
is "  ...at a higher revision" yes "$(jq -rn --argjson a "${r1:-null}" --argjson b "${r2:-null}" \
  'if $a and $b and ($b.rev > $a.rev) then "yes" else "no" end')"
is "  ...under a new id" yes "$(jq -rn --argjson a "${r1:-null}" --argjson b "${r2:-null}" \
  'if $a and $b and ($b.id != $a.id) then "yes" else "no" end')"

# every read from here on: the new text or nothing, never the old; up to
# two of B's revision-list ttls for the new text to arrive
stale=0; fresh=0
for _ in $(seq 1 75); do
  got=$(read_)
  grep -qF "$OLD" <<<"$got" && stale=$((stale+1))
  grep -qF "$NEW" <<<"$got" && { fresh=1; break; }
  sleep 2
done
is "B never reads the old text again" 0 "$stale"
is "B reads the new text" 1 "$fresh"
# and again after B's cached list has had time to go stale
sleep 5
got=$(read_)
grep -qF "$NEW" <<<"$got" && ok "  ...and keeps reading it" || fail "  ...and keeps reading it" "$(head -c 300 <<<"$got")"
grep -qF "$OLD" <<<"$got" && fail "  ...without the old" || ok "  ...without the old"

echo
[ "$fails" -eq 0 ] && echo "two-ship-republish: all passed" || echo "two-ship-republish: $fails failed"
[ "$fails" -eq 0 ]
