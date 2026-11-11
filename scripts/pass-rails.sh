#!/usr/bin/env bash
# Paying for a pass by card (Stripe Checkout) and in bitcoin (BTCPay), end
# to end, against scripts/fake-rails.py standing in for both rails. A reader
# with no ship pays on each rail's page and reads on the cookie; the rail's
# webhook and the return page settle it once; a BTCPay webhook with a bad
# signature is refused; an expired invoice ends the payment; the seller's
# numbers count dollars. About a minute. Never point this at a real ship or
# a real rail: it sets the rails' urls to the fake.
#
# Usage:  scripts/pass-rails.sh
# Env:    LATTICE_URL     ship base (required, a throwaway ship)
#         LATTICE_COOKIE  cookie file (required)
#         RAILS_PORT      the fake's port (default 3412)
set -uo pipefail

. "$(dirname "${BASH_SOURCE[0]}")/lib/matrix.sh"
need_cookie
PORT="${RAILS_PORT:-3412}"
F="http://127.0.0.1:$PORT"
HOOK="passrails$$"
BD="pr$$"
A="$URL/apps/lattice"
J=$(mktemp -d /tmp/pass-rails.XXXX)

code(){ curl -s -o /dev/null -w '%{http_code}' "$@"; }
G()   { curl -s -H "$CK" "$@"; }
P()   { code -H "$CK" -X POST "$@"; }
py()  { printf '%s' "$1" | python3 -c "import json,sys; j=json.load(sys.stdin); print($2)"; }

python3 "$(dirname "$0")/fake-rails.py" "$PORT" "$HOOK" "$URL" & FAKE=$!
trap 'kill $FAKE 2>/dev/null; rm -rf "$J"' EXIT
for i in $(seq 1 20); do curl -s -o /dev/null "$F/stub/state" && break; sleep 0.5; done

echo "==> a private board selling a day for \$2.50, by card and in bitcoin"
is "make the board" 303 "$(P "$B/forum/_new" --data "name=$BD&title=Rails")"
is "make it private" 303 "$(P "$B/forum/$BD/mod/public")"
is "post on it" 303 "$(P "$B/forum/$BD/submit" --data "title=inside&body=for+payers")"
is "the offer" 200 "$(P "$B/pass-offer?board=$BD" --data '{"sats":0,"cents":250,"minutes":1440,"mode":"read","mint":"","open":true}')"
S="{\"stripe\":\"sk_test_rails\",\"stripe-url\":\"$F\",\"btcpay-url\":\"$F\",\"btcpay-store\":\"st1\",\"btcpay-key\":\"railskey\",\"btcpay-hook\":\"$HOOK\"}"
is "the rails, at the fake" 200 "$(P "$B/pass-settings" --data "$S")"
j=$(G "$B/pass-settings")
is "card on, in test mode" 'True test' "$(py "$j" "str(j['card'])+' '+j['stripe']")"
is "bitcoin on" True "$(py "$j" "j['bitcoin']")"
pg=$(curl -s "$A/forum/$BD")
has "a card button" 'Pay $2.50 by card' "$pg"
has "a bitcoin button" 'Pay $2.50 in bitcoin' "$pg"

echo "==> card"
to=$(curl -s -o /dev/null -w '%{redirect_url}' -b "$J/a" -c "$J/a" -X POST "$A/pass/card?board=$BD")
has "sent to Stripe's page" "$F/stub/stripe/page/" "$to"
sid=${to##*/}; sid=${sid%%\?*}
st=$(curl -s "$F/stub/state")
is "the session's price" 250 "$(py "$st" "j['sessions']['$sid']['amount_total']")"
pg=$(curl -s -b "$J/a" "$A/pass/state?board=$BD&t=0v0")
r=$(curl -s -X POST "$F/stub/stripe/pay/$sid")
is "Stripe's webhook was taken" 200 "$(py "$r" "j['hook']")"
back=$(py "$r" "j['return']")
pg=$(curl -s -L -b "$J/a" -c "$J/a" "$back")
has "paid" '<h1>Paid' "$pg"
has "the board reads on the cookie" 'inside' "$(curl -s -b "$J/a" "$A/forum/$BD")"
pg=$(curl -s -L -b "$J/a" "$back")
has "the return again is the same page, settled once" '<h1>Paid' "$pg"

echo "==> bitcoin"
to=$(curl -s -o /dev/null -w '%{redirect_url}' -b "$J/b" -c "$J/b" -X POST "$A/pass/bitcoin?board=$BD")
has "sent to BTCPay's page" "$F/stub/btcpay/page/" "$to"
iid=${to##*/}; iid=${iid%%\?*}
st=$(curl -s "$F/stub/state")
is "the invoice in dollars" '2.50 USD' "$(py "$st" "j['invoices']['$iid']['amount']+' '+j['invoices']['$iid']['currency']")"
back=$(py "$st" "j['invoices']['$iid']['redirectURL']")
has "waiting while unpaid" 'Waiting for the payment' "$(curl -s -L -b "$J/b" "$back")"
bad=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$A/hooks/btcpay" -H 'btcpay-sig: sha256=00' --data "{\"type\":\"InvoiceSettled\",\"invoiceId\":\"$iid\"}")
is "a webhook with a bad signature is refused" 401 "$bad"
r=$(curl -s -X POST "$F/stub/btcpay/pay/$iid")
is "the signed webhook was taken" 200 "$(py "$r" "j['hook']")"
pg=$(curl -s -L -b "$J/b" -c "$J/b" "$back")
has "paid" '<h1>Paid' "$pg"
has "the board reads on this cookie too" 'inside' "$(curl -s -b "$J/b" "$A/forum/$BD")"

echo "==> an invoice that expires"
to=$(curl -s -o /dev/null -w '%{redirect_url}' -b "$J/c" -c "$J/c" -X POST "$A/pass/bitcoin?board=$BD")
iid=${to##*/}; iid=${iid%%\?*}
back=$(py "$(curl -s "$F/stub/state")" "j['invoices']['$iid']['redirectURL']")
curl -s -o /dev/null -X POST "$F/stub/btcpay/expire/$iid"
has "the payment failed" 'expired' "$(curl -s -L -b "$J/c" "$back")"
hasnt "and the board stays shut" 'inside' "$(curl -s -b "$J/c" "$A/forum/$BD")"

echo "==> the seller"
j=$(G "$B/passes?board=$BD")
is "two passes" 2 "$(py "$j" "j['active']")"
is "five dollars this month" 500 "$(py "$j" "j['month']['usd']")"
is "one by card, one in bitcoin" 'bitcoin card' "$(py "$j" "' '.join(sorted(p['via'] for p in j['passes']))")"
has "the mod page shows both rails on" 'Bitcoin: on' "$(G "$B/forum/$BD/mod")"

is "turn the rails off" 200 "$(P "$B/pass-settings" --data '{"stripe":"","stripe-url":"","btcpay-url":"","btcpay-store":"","btcpay-key":"","btcpay-hook":""}')"
is "delete the board" 303 "$(P "$B/forum/$BD/mod/delete")"
finish
