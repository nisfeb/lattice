#!/usr/bin/env bash
# Repro / regression test for the cross-ship "no response from peer" fetch bug.
#
# Symptom: browsing another ship's page returns "no response from peer" even
# though that ship is online and publishing — and you can read your own files.
#
# Cause: a publication whose LATEST revision is served but whose rev 1 is NOT
# (a gap left in gall's remote-scry farm by a past nuke/reinstall — the farm
# outlives agent state, so old tombstoned revs persist). lattice's fetch walks
# revisions starting at %ud 1; it stalls on the unserved rev 1, the ~s30
# deadline fires with "nothing seen", and the agent answers 504 — never
# reaching the latest rev where the content actually is.
#
# This is RED today. It goes GREEN once fetch targets the latest revision
# directly instead of walking up from rev 1.
#
# Drive two already-running fake ships (~zod publisher, ~tyr consumer) via their
# lattice HTTP API. Cookies come from env (see .mcp.json for the zod cookie;
# pass the tyr cookie via SUB_COOKIE). Example:
#
#   SUB_COOKIE='urbauth-~tyr=0v1.…' ./scripts/rev-gap-repro.sh
#
set -u

SUB_URL="${SUB_URL:-http://localhost:8082}"      # consumer ship (does the fetch) — ~tyr public port
SUB_COOKIE="${SUB_COOKIE:?set SUB_COOKIE to the consumer ship urbauth cookie}"
PUB_SHIP="${PUB_SHIP:-~zod}"                      # publisher @p
GAP_PATH="${GAP_PATH:-notes/2026/ok}"            # a publication with rev 1 unserved
GAP_BODY="${GAP_BODY:-fine}"                      # its latest-rev content

q() { curl -s -m "${2:-35}" "$SUB_URL/apps/lattice/fetch?url=urb://$PUB_SHIP/$GAP_PATH$1" -H "Cookie: $SUB_COOKIE"; }

echo "# precondition — the gap that triggers the bug"
r1="$(q '&rev=1' 7 | tr -d '\n')"
echo "  rev=1 (low rev): ${r1:-<pending/timeout — NOT served>}"
served=""
for r in 2 3 4 5 6; do
  b="$(q "&rev=$r" 6)"
  echo "$b" | grep -q '"body"' && served="rev $r = $(printf '%s' "$b" | python3 -c 'import sys,json;print(json.load(sys.stdin)["body"].strip())' 2>/dev/null)"
done
echo "  latest served: ${served:-<none found>}"

echo "# the bug — walk-to-latest (no rev) must return the latest content"
out="$(q '' 35 | tr -d '\n')"
echo "  fetch (no rev): $out"

if printf '%s' "$out" | grep -q "\"body\":\"$GAP_BODY\""; then
  echo "PASS — latest content returned (bug fixed)"
  exit 0
else
  echo "FAIL — walk-from-1 stalled on the unserved low rev (bug present)"
  exit 1
fi
