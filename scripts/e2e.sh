#!/usr/bin/env bash
# End-to-end test of the lattice HTTP API against a running ship. Contract-based,
# so it works against the grubbery `lattice` nexus (the endpoints are unchanged).
#
# Exercises the same path a real client uses: login, list, save (-> publish),
# fetch local, delete, and (optionally) a cross-ship remote fetch.
#
# Usage:
#   scripts/e2e.sh [ship-url] [code]
# Env (override the args):
#   LATTICE_URL   (default http://localhost:8081)
#   LATTICE_CODE  (default lidlut-tabwed-pillex-ridrup, a fresh fakezod)
#   LATTICE_PEER_SHIP / LATTICE_PEER_FILE  if set, also test a cross-ship
#                                          fetch of urb://<peer>/<file>
set -uo pipefail

URL="${1:-${LATTICE_URL:-http://localhost:8081}}"
CODE="${2:-${LATTICE_CODE:-lidlut-tabwed-pillex-ridrup}}"
URL="${URL%/}"
JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT

fail=0
ok()   { echo "  ok   — $1"; }
bad()  { echo "  FAIL — $1"; fail=1; }
# has   <name> <needle> <haystack>   — the order api-matrix.sh and mcp-matrix.sh
# hasnt <name> <needle> <haystack>     use, so a call copied between them holds
has()  { if printf '%s' "$3" | grep -qF -- "$2"; then ok "$1"; else bad "$1 (expected '$2' in: $3)"; fi; }
hasnt(){ if printf '%s' "$3" | grep -qF -- "$2"; then bad "$1 (unexpected '$2' in: $3)"; else ok "$1"; fi; }

echo "==> login $URL"
code=$(curl -s -o /dev/null -w '%{http_code}' -c "$JAR" -X POST "$URL/~/login" --data "password=${CODE#+}")
[ "$code" = "204" ] || [ "$code" = "200" ] || { echo "login failed (HTTP $code)"; exit 1; }

SHIP=$(curl -s -b "$JAR" "$URL/~/host")
echo "==> ship: $SHIP"
B="$URL/apps/lattice"
P="scratch/e2e-$$"

echo "==> list"
has "list returns JSON files array" '"files"' "$(curl -s -b "$JAR" "$B/list")"

echo "==> save $P"
has "save returns ok" '"ok":true' "$(printf '# e2e\n\nhello from e2e.\n' | curl -s -b "$JAR" -X POST --data-binary @- "$B/save?path=$P")"
sleep 1

echo "==> fetch urb://$SHIP/$P"
has "fetch returns saved body" 'hello from e2e.' "$(curl -s -b "$JAR" -G "$B/fetch" --data-urlencode "url=urb://$SHIP/$P")"
has "list now includes the file" "$P" "$(curl -s -b "$JAR" "$B/list")"

echo "==> delete $P"
has "delete returns ok" '"ok":true' "$(curl -s -b "$JAR" -X POST "$B/delete?path=$P")"
sleep 1
hasnt "fetch after delete is not found" 'hello from e2e.' "$(curl -s -b "$JAR" -G "$B/fetch" --data-urlencode "url=urb://$SHIP/$P")"

if [ -n "${LATTICE_PEER_SHIP:-}" ]; then
  PF="${LATTICE_PEER_FILE:-from-tyr}"
  echo "==> cross-ship fetch urb://$LATTICE_PEER_SHIP/$PF"
  resp=$(curl -s -b "$JAR" -G "$B/fetch" --data-urlencode "url=urb://$LATTICE_PEER_SHIP/$PF")
  has "cross-ship fetch returns a gmi body" '"mark":"gmi"' "$resp"
fi

echo
if [ "$fail" = 0 ]; then echo "e2e PASSED"; else echo "e2e FAILED"; fi
exit "$fail"
