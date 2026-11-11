#!/usr/bin/env bash
# Passes integration matrix (docs/superpowers/specs/2026-11-11-passes-design.md):
# the seller's routes, the read group a pass keeps, a lapse with no owner
# action, a refund, and a board's delete taking its passes. One ship is
# enough: gifts stand in for payment, and the groups show the read gate.
# Takes about two minutes, most of it waiting for a one-minute pass to end.
#
# Usage:  scripts/pass-matrix.sh
# Env:    LATTICE_URL     ship base (required, a throwaway ship)
#         LATTICE_COOKIE  cookie file (required)
set -uo pipefail

. "$(dirname "${BASH_SOURCE[0]}")/lib/matrix.sh"
need_cookie
BD="px$$"                    # per-run board, deleted at the end
PB="px$$p"                   # a public board, which sells nothing

code(){ curl -s -o /dev/null -w '%{http_code}' "$@"; }
G()   { curl -s -H "$CK" "$@"; }
P()   { code -H "$CK" -X POST "$@"; }
# py <json> <expr>: one value out of a json answer, j is the json
py()  { printf '%s' "$1" | python3 -c "import json,sys; j=json.load(sys.stdin); print($2)"; }
passes() { G "$B/passes?board=$BD"; }
group()  { G "$B/share-groups" | python3 -c "
import json,sys
gs=[g for g in json.load(sys.stdin) if g['name'] in ('forum-$BD','/forum-$BD')]
print(' '.join(sorted(gs[0]['ships'])) if gs else '<none>')"; }

echo "==> a private board and a public one"
is "make the board" 303 "$(P "$B/forum/_new" --data "name=$BD&title=Passes")"
is "make it private" 303 "$(P "$B/forum/$BD/mod/public")"
is "make a public board" 303 "$(P "$B/forum/_new" --data "name=$PB&title=Open")"

echo "==> offers"
j=$(passes)
is "no offer yet" None "$(py "$j" "j['offer']")"
is "nothing active" 0 "$(py "$j" "j['active']")"
OFF='{"sats":1000,"cents":500,"minutes":43200,"mode":"post","mint":"http://localhost:9","open":true}'
is "set an offer" 200 "$(P "$B/pass-offer?board=$BD" --data "$OFF")"
j=$(passes)
is "offer sats" 1000 "$(py "$j" "j['offer']['sats']")"
is "offer days" 30 "$(py "$j" "j['offer']['days']")"
is "sats need a mint" 400 "$(P "$B/pass-offer?board=$BD" --data '{"sats":1000,"cents":0,"minutes":60,"mode":"post","mint":"","open":true}')"
is "a period under a minute" 400 "$(P "$B/pass-offer?board=$BD" --data '{"sats":0,"cents":500,"minutes":0,"mode":"post","mint":"","open":true}')"
is "a public board sells nothing" 400 "$(P "$B/pass-offer?board=$PB" --data "$OFF")"
is "no such board" 400 "$(P "$B/pass-offer?board=nope$$" --data "$OFF")"
is "seller routes need the owner" 403 "$(code -X POST "$B/pass-gift?board=$BD&ship=~nec&minutes=1")"

echo "==> gifts and the read group"
is "gift ~nec a minute" 200 "$(P "$B/pass-gift?board=$BD&ship=~nec&minutes=1")"
is "gift ~bus ten hours, read" 200 "$(P "$B/pass-gift?board=$BD&ship=~bus&minutes=600&mode=read")"
is "a gift needs minutes" 400 "$(P "$B/pass-gift?board=$BD&ship=~nec")"
j=$(passes)
is "two active" 2 "$(py "$j" "j['active']")"
is "soonest first" '~nec' "$(py "$j" "j['passes'][0]['ship']")"
is "~bus reads only" read "$(py "$j" "[p for p in j['passes'] if p['ship']=='~bus'][0]['mode']")"
is "a gift is no income" 0 "$(py "$j" "j['month']['sat']+j['month']['usd']")"
is "both read the board" '~bus ~nec' "$(group)"

echo "==> a lapse closes reads with no owner action (about 70 s)"
sleep 70
j=$(passes)
is "one active" 1 "$(py "$j" "j['active']")"
is "~nec lapsed" False "$(py "$j" "[p for p in j['passes'] if p['ship']=='~nec'][0]['live']")"
is "one lapse" 1 "$(py "$j" "j['lapses']")"
is "~nec is out of the read group" '~bus' "$(group)"
has "the seller heard" 'lapsed' "$(G "$B/notify")"

echo "==> renewal and refund"
is "gift ~nec again" 200 "$(P "$B/pass-gift?board=$BD&ship=~nec&minutes=60")"
is "~nec reads again" '~bus ~nec' "$(group)"
is "refund ~bus" 200 "$(P "$B/pass-refund?board=$BD&holder=~bus")"
j=$(passes)
is "~bus ended" False "$(py "$j" "[p for p in j['passes'] if p['ship']=='~bus'][0]['live']")"
is "~bus is out" '~nec' "$(group)"
is "a bad holder" 400 "$(P "$B/pass-refund?board=$BD&holder=nobody")"

echo "==> deleting the board takes its passes"
is "delete the board" 303 "$(P "$B/forum/$BD/mod/delete")"
is "delete the public one" 303 "$(P "$B/forum/$PB/mod/delete")"
j=$(passes)
is "no passes" 0 "$(py "$j" "len(j['passes'])")"
is "no offer" None "$(py "$j" "j['offer']")"

finish
