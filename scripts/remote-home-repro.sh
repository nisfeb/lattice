#!/usr/bin/env bash
# Repro / regression test for the cross-ship "no response from peer" browse bug.
#
# Browsing a ship loads urb://~ship/ (empty path). For a REMOTE ship the agent
# keens the EMPTY spur — where nothing is ever published (files live at /index,
# /manifest, /shared/…) — so the keen pends to the ~30s deadline and 504s with
# "no response from peer". Own-ship and individual files/manifest work fine.
#
# Fix (publisher-side): the agent grows its home page (authored /index, else the
# generated index) at the empty spur (state-4 `home-cards`), so a remote home
# keen resolves. RED before the PUBLISHER runs the fix; GREEN after.
#
# Run against the fakes (consumer ~tyr fetching publisher ~zod):
#   SUB_COOKIE='urbauth-~tyr=…' ./scripts/remote-home-repro.sh
set -u
SUB_URL="${SUB_URL:-http://localhost:8082}"      # consumer ship (does the fetch) — ~tyr public port
SUB_COOKIE="${SUB_COOKIE:?set SUB_COOKIE to the consumer ship urbauth cookie}"
PUB_SHIP="${PUB_SHIP:-~zod}"                      # publisher whose home we browse

out="$(curl -s -m 35 "$SUB_URL/apps/lattice/fetch?url=urb://$PUB_SHIP/" -H "Cookie: $SUB_COOKIE" | tr -d '\n')"
echo "fetch urb://$PUB_SHIP/ (empty home) -> $out"
if printf '%s' "$out" | grep -q '"body"'; then
  echo "PASS — remote home resolved"
  exit 0
else
  echo "FAIL — remote home returned no content (empty-spur home bug present)"
  exit 1
fi
