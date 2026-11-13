#!/usr/bin/env bash
# Passes integration matrix (docs/superpowers/specs/2026-11-11-passes-design.md):
# the seller's routes, the read group a pass keeps, a lapse with no owner
# action, a refund, and a board's delete taking its passes. One ship is
# enough: gifts stand in for payment, and the read group lattice states in
# its groups.json shows the read gate. The shell makes that a usergroup only
# once the owner grants lattice the /lattice/ key on Permits, so the matrix
# reads what lattice states, not the usergroup.
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
INST=/apps/shell/desks/lattice.desk/desk/data/lattice.lattice_app
group()  { G "$URL/grubbery/api/file$INST/groups.json" | python3 -c "
import json,sys
g=json.load(sys.stdin).get('/lattice/',{}).get('pass-b-$BD')
print(' '.join(sorted(g['members'])) if g else '<none>')"; }

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
is "refund ~bus again" 200 "$(P "$B/pass-refund?board=$BD&holder=~bus")"
is "a pass is refunded once" 1 "$(py "$(passes)" "len([p for p in j['passes'] if p['ship']=='~bus'])")"
is "invite ~nec by hand" 200 "$(P "$B/forum-invite?board=$BD&ship=~nec")"
is "revoke the hand invite" 200 "$(P "$B/forum-revoke?board=$BD&ship=~nec")"
is "~nec still reads on its pass" '~nec' "$(group)"
is "a bad holder" 400 "$(P "$B/pass-refund?board=$BD&holder=nobody")"

echo "==> the mod page's Passes forms"
pg=$(G "$B/forum/$BD/mod")
has "the Passes section" '<h4>Passes</h4>' "$pg"
has "the numbers" 'Active: 1.' "$pg"
has "a refund button for a live pass" 'value="refund"' "$pg"
hasnt "a public board has none" '<h4>Passes</h4>' "$(G "$B/forum/$PB/mod")"
is "a sats offer with no mint is refused" 400 "$(P "$B/forum/$BD/mod/passes" --data 'sats=500&days=7&mode=read&open=on' --data-urlencode 'mint=')"
is "so the offer stands" 1000 "$(py "$(passes)" "j['offer']['sats']")"
is "save one with a mint" 303 "$(P "$B/forum/$BD/mod/passes" --data 'sats=2100&days=7&mode=read&open=on' --data-urlencode 'mint=http://localhost:9')"
is "the form's offer" '2100 7 read True' "$(py "$(passes)" "' '.join(str(j['offer'][k]) for k in ('sats','days','mode','open'))")"
is "give by form" 303 "$(P "$B/forum/$BD/mod/pass-gift" --data 'ship=~wet&days=2&mode=post')"
is "~wet holds one" post "$(py "$(passes)" "[p for p in j['passes'] if p['ship']=='~wet'][0]['mode']")"
is "refund by form" 303 "$(P "$B/forum/$BD/mod/pass-refund" --data 'holder=~wet')"
is "~wet ended" False "$(py "$(passes)" "[p for p in j['passes'] if p['ship']=='~wet'][0]['live']")"
is "stop selling" 303 "$(P "$B/forum/$BD/mod/passes-off")"
is "no offer now" None "$(py "$(passes)" "j['offer']")"

echo "==> rail settings (the rails themselves: scripts/pass-rails.sh)"
is "a card offer" 200 "$(P "$B/pass-offer?board=$BD" --data '{"sats":0,"cents":350,"minutes":60,"mode":"read","mint":"","open":true}')"
pg=$(curl -s "$URL/apps/lattice/forum/$BD")
hasnt "no card button with no Stripe key" 'by card' "$pg"
is "no key, no card session" 502 "$(code -X POST "$URL/apps/lattice/pass/card?board=$BD")"
is "a Stripe key must look like one" 400 "$(P "$B/pass-settings" --data '{"stripe":"pk_test_nope"}')"
is "a url must be one" 400 "$(P "$B/pass-settings" --data '{"btcpay-url":"btcpay.example"}')"
is "set a fake test key" 200 "$(P "$B/pass-settings" --data '{"stripe":"sk_test_passmatrixfake","btcpay-key":"passmatrixbtc"}')"
j=$(G "$B/pass-settings")
is "card is on" True "$(py "$j" "j['card']")"
is "bitcoin needs a url and a store too" False "$(py "$j" "j['bitcoin']")"
hasnt "no key comes back" 'passmatrix' "$j$(G "$B/passes?board=$BD")$(G "$B/forum/$BD/mod")"
has "the buy page offers a card" 'Pay $3.50 by card' "$(curl -s "$URL/apps/lattice/forum/$BD")"
is "Stripe refuses a fake key" 502 "$(code -X POST "$URL/apps/lattice/pass/card?board=$BD")"
is "a webhook for no session of ours" 200 "$(code -X POST "$URL/apps/lattice/hooks/stripe" --data '{"type":"checkout.session.completed","data":{"object":{"id":"cs_nope"}}}')"
is "a return with a bad token" 400 "$(code "$URL/apps/lattice/pass/return?board=$BD&t=x")"
is "clear both" 200 "$(P "$B/pass-settings" --data '{"stripe":"","btcpay-key":""}')"
is "card is off" False "$(py "$(G "$B/pass-settings")" "j['card']")"

echo "==> deleting the board takes its passes"
is "delete the board" 303 "$(P "$B/forum/$BD/mod/delete")"
is "delete the public one" 303 "$(P "$B/forum/$PB/mod/delete")"
j=$(passes)
is "no passes" 0 "$(py "$j" "len(j['passes'])")"
is "no offer" None "$(py "$j" "j['offer']")"
is "and no read group" '<none>' "$(group)"

finish
