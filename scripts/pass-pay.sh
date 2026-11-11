#!/usr/bin/env bash
# Paying for a pass on the open web, end to end, against a local test mint:
# nutshell with its FakeWallet, which pays every invoice it issues by itself
# (set it up as docs/superpowers/specs/2026-11-11-passes-design.md, Testing,
# says). A reader with no ship pays by Lightning and reads a private board on
# the cookie; a second browser uses the code; a cashuA token buys a renewal
# and the same token again is refused as spent; the seller's numbers and
# wallet match, and the wallet's token is good at the mint; the pass lapses
# and the board is a buy page again. About four minutes, most of it waiting
# for a pass to end. Never point this at a real ship or mint.
#
# Usage:  scripts/pass-pay.sh
# Env:    LATTICE_URL     ship base (required, a throwaway ship)
#         LATTICE_COOKIE  cookie file (required)
#         PASS_MINT       the test mint (default http://127.0.0.1:3338)
#         CASHU_VENV      the virtualenv nutshell is installed in (required)
set -uo pipefail

. "$(dirname "${BASH_SOURCE[0]}")/lib/matrix.sh"
need_cookie
MINT="${PASS_MINT:-http://127.0.0.1:3338}"
VENV="${CASHU_VENV:?set CASHU_VENV to the nutshell virtualenv}"
export CASHU_DIR; CASHU_DIR=$(mktemp -d /tmp/pass-pay-wallet.XXXX)
export MINT_URL="$MINT"
cashu() { timeout 120 "$VENV/bin/cashu" "$@" 2>&1; }
BD="pp$$"
A="$URL/apps/lattice"        # anonymous routes and pages
J=$(mktemp -d /tmp/pass-pay-jars.XXXX)

code(){ curl -s -o /dev/null -w '%{http_code}' "$@"; }
G()   { curl -s -H "$CK" "$@"; }
P()   { code -H "$CK" -X POST "$@"; }
py()  { printf '%s' "$1" | python3 -c "import json,sys; j=json.load(sys.stdin); print($2)"; }
# state <jar> <url>: follow a payment's page until it ends, at most 90 s
state() {
  local page="" i
  for i in $(seq 1 45); do
    page=$(curl -s -b "$1" -c "$1" "$2")
    case "$page" in *'<h1>Paid'*|*'<h1>Payment failed'*) break ;; esac
    sleep 2
  done
  printf '%s' "$page"
}
# buy <jar> <form...>: start a web payment, print its page's url
buy() {
  local jar=$1; shift
  curl -s -o /dev/null -w '%{redirect_url}' -b "$jar" -c "$jar" -X POST "$A/pass/buy?board=$BD" "$@"
}

echo "==> a private board selling one-minute passes for 100 sats"
is "make the board" 303 "$(P "$B/forum/_new" --data "name=$BD&title=Paid")"
is "make it private" 303 "$(P "$B/forum/$BD/mod/public")"
is "post on it" 303 "$(P "$B/forum/$BD/submit" --data "title=inside&body=only+for+pass+holders")"
OFF="{\"sats\":100,\"cents\":0,\"minutes\":1,\"mode\":\"read\",\"mint\":\"$MINT\",\"open\":true}"
is "set the offer" 200 "$(P "$B/pass-offer?board=$BD" --data "$OFF")"

echo "==> a reader with no ship sees the buy page"
pg=$(curl -s "$A/forum/$BD")
has "the buy page" 'Pay over Lightning' "$pg"
has "the price" '100 sats' "$pg"
hasnt "no posts" 'inside' "$pg"

echo "==> Lightning"
to=$(buy "$J/a" --data "ln=1")
has "sent to its page" '/apps/lattice/pass/state' "$to"
pg=$(state "$J/a" "$to")
has "paid (the fake wallet pays the invoice)" '<h1>Paid' "$pg"
CODE=$(printf '%s' "$pg" | grep -o 'class="code">0v[^<]*' | head -1 | sed 's/.*">//')
has "the code is shown" '0v' "$CODE"
has "the cookie is set" "lattice-pass-b-$BD" "$(cat "$J/a")"
has "the board reads on the cookie" 'inside' "$(curl -s -b "$J/a" "$A/forum/$BD")"
hasnt "and not without it" 'inside' "$(curl -s "$A/forum/$BD")"

echo "==> the code on another browser"
is "use the code" 303 "$(code -c "$J/b" -X POST "$A/pass/use?board=$BD" --data "code=$CODE")"
has "the second browser reads" 'inside' "$(curl -s -b "$J/b" "$A/forum/$BD")"
has "a wrong code is refused" 'no live pass' "$(curl -s -X POST "$A/pass/use?board=$BD" --data 'code=0v1.23456')"

echo "==> ecash renews, and a token spends once"
is "fund the test wallet" 0 "$(cashu invoice 400 >/dev/null; echo $?)"
TOK=$(cashu send --legacy 150 | grep -o 'cashuA[A-Za-z0-9_=-]*' | head -1)
has "a cashuA token" 'cashuA' "$TOK"
to=$(buy "$J/a" --data-urlencode "token=$TOK")
has "renewed with ecash" '<h1>Paid' "$(state "$J/a" "$to")"
to=$(buy "$J/c" --data-urlencode "token=$TOK")
pg=$(state "$J/c" "$to")
has "the same token again fails" 'Payment failed' "$pg"
to=$(buy "$J/c" --data-urlencode "token=cashuAbogus")
has "a bad token fails" 'not a cashuA token' "$(state "$J/c" "$to")"
SHORT=$(cashu send --legacy 50 | grep -o 'cashuA[A-Za-z0-9_=-]*' | head -1)
to=$(buy "$J/c" --data-urlencode "token=$SHORT")
has "a short token fails" 'less than the price' "$(state "$J/c" "$to")"

echo "==> the seller"
j=$(G "$B/passes?board=$BD")
is "one web pass: the renewal extended it" 1 "$(py "$j" "len(j['passes'])")"
is "it is live" 1 "$(py "$j" "j['active']")"
inc=$(py "$j" "j['month']['sat']")
[ "$inc" -ge 248 ] && ok "income is the two payments less fees ($inc)" || bad "income" "got $inc"
has "the seller heard" 'bought a pass' "$(G "$B/notify")"
w=$(G "$B/pass-wallet?board=$BD")
is "one mint in the wallet" 1 "$(py "$w" "len(j)")"
is "the wallet holds the income" "$inc" "$(py "$w" "j[0]['sats']")"
WT=$(py "$w" "j[0]['token']")
has "the seller can redeem it at the mint" 'Received' "$(cashu receive "$WT")"
is "take it out of the wallet" 200 "$(P "$B/pass-wallet-take?board=$BD&mint=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$MINT")")"
is "the wallet is empty" 0 "$(py "$(G "$B/pass-wallet?board=$BD")" "len(j)")"

echo "==> the pass lapses (about two minutes after it was bought)"
sleep 120
pg=$(curl -s -b "$J/b" "$A/forum/$BD")
has "the board is a buy page again" 'Pay over Lightning' "$pg"
has "saying the pass ended" 'Your pass ended' "$pg"

is "delete the board" 303 "$(P "$B/forum/$BD/mod/delete")"
rm -rf "$J" "$CASHU_DIR"
finish
