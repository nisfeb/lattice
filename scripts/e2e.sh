#!/usr/bin/env bash
# End-to-end test of the %lattice desk over HTTP against a running ship.
#
# Exercises the same path a real client uses: login, list, save (-> publish),
# fetch local, delete, and (optionally) a cross-ship fetch via Ames %keen.
#
# Usage:
#   scripts/e2e.sh [ship-url] [code]
# Env (override the args):
#   LATTICE_URL   (default http://localhost:8081)
#   LATTICE_CODE  (default lidlut-tabwed-pillex-ridrup — a fresh fakezod)
#   LATTICE_PEER_SHIP / LATTICE_PEER_FILE  — if set, also test a cross-ship
#                                            fetch of urb://<peer>/<file>
set -uo pipefail

URL="${1:-${LATTICE_URL:-http://localhost:8081}}"
CODE="${2:-${LATTICE_CODE:-lidlut-tabwed-pillex-ridrup}}"
URL="${URL%/}"
JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT

fail=0
ok()   { echo "  ok   — $1"; }
bad()  { echo "  FAIL — $1"; fail=1; }
has()  { if printf '%s' "$2" | grep -qF -- "$3"; then ok "$1"; else bad "$1 (expected '$3' in: $2)"; fi; }
hasnt(){ if printf '%s' "$2" | grep -qF -- "$3"; then bad "$1 (unexpected '$3' in: $2)"; else ok "$1"; fi; }

echo "==> login $URL"
code=$(curl -s -o /dev/null -w '%{http_code}' -c "$JAR" -X POST "$URL/~/login" --data "password=${CODE#+}")
[ "$code" = "204" ] || [ "$code" = "200" ] || { echo "login failed (HTTP $code)"; exit 1; }

SHIP=$(curl -s -b "$JAR" "$URL/~/host")
echo "==> ship: $SHIP"
B="$URL/apps/lattice"
P="scratch/e2e-$$"

echo "==> list"
has "list returns JSON files array" "$(curl -s -b "$JAR" "$B/list")" '"files"'

echo "==> save $P"
has "save returns ok" "$(printf '# e2e\n\nhello from e2e.\n' | curl -s -b "$JAR" -X POST --data-binary @- "$B/save?path=$P")" '"ok":true'
sleep 1

echo "==> fetch urb://$SHIP/$P"
has "fetch returns saved body" "$(curl -s -b "$JAR" -G "$B/fetch" --data-urlencode "url=urb://$SHIP/$P")" 'hello from e2e.'
has "list now includes the file" "$(curl -s -b "$JAR" "$B/list")" "$P"

echo "==> delete $P"
has "delete returns ok" "$(curl -s -b "$JAR" -X POST "$B/delete?path=$P")" '"ok":true'
sleep 1
hasnt "fetch after delete is not found" "$(curl -s -b "$JAR" -G "$B/fetch" --data-urlencode "url=urb://$SHIP/$P")" 'hello from e2e.'

if [ -n "${LATTICE_PEER_SHIP:-}" ]; then
  PF="${LATTICE_PEER_FILE:-from-tyr}"
  echo "==> cross-ship fetch urb://$LATTICE_PEER_SHIP/$PF"
  resp=$(curl -s -b "$JAR" -G "$B/fetch" --data-urlencode "url=urb://$LATTICE_PEER_SHIP/$PF")
  has "cross-ship fetch returns a gmi body" "$resp" '"mark":"gmi"'
fi

echo
if [ "$fail" = 0 ]; then echo "e2e PASSED"; else echo "e2e FAILED"; fi
exit "$fail"
