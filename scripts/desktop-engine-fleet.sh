#!/usr/bin/env bash
# A real read through the desktop's urb engine, on the fleet: claims the
# lattice-gate-peer set (~wep), resets it to its lattice snapshot,
# publishes a gemtext page on it, and runs the engine's ignored test,
# which reads that page as a fake moon (the fake network has no comets).
# The claim is released at the end, on failure too. Fake fleet ships
# only, never a live one.
#
# Usage:  FLEET_WHO=<you> scripts/desktop-engine-fleet.sh
# Env:    FLEET (the fleet script), KEEP=1 to leave the set claimed and
#         running for a following check (release it yourself).
#
# Exits 0 with "skipped" when the set is claimed by someone else.
set -euo pipefail

: "${FLEET_WHO:?set FLEET_WHO to who is claiming the set}"
FLEET=${FLEET:-$HOME/software/personal/hoon-development/fleet/fleet}
SET=lattice-gate-peer
PIER=$HOME/fleet/piers/wep
URL=http://localhost:8151
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/.." && pwd)

holder=$("$FLEET" ls 2>/dev/null | awk -v s="$SET" '$1==s' | grep -oE '\([^)]*\)' | tr -d '()' || true)
if [ -n "$holder" ] && [ "$holder" != "$FLEET_WHO" ]; then
  echo "skipped: $SET is claimed by $holder"
  exit 0
fi
"$FLEET" claim "$SET" "$FLEET_WHO"
tmp=$(mktemp -d)
cleanup() {
  rm -rf "$tmp"
  if [ "${KEEP:-}" != 1 ]; then
    "$FLEET" down "$SET" >/dev/null 2>&1 || true
    "$FLEET" release "$SET" || true
  fi
}
trap cleanup EXIT

"$FLEET" reset "$SET" lattice
reset_at=$(date +%s)

VERE=$(awk '$1=="stock"{print $2}' "$(dirname "$FLEET")/kernels.conf")
VERE=${VERE/#\~/$HOME}
VERE=$VERE "$repo/scripts/hoon-test-kit/ship-cookie.sh" "$PIER" "$URL" "$tmp/wep.jar"
cookie="Cookie: $(awk '$6 ~ /^urbauth/ {print $6"="$7}' "$tmp/wep.jar")"

nonce="engine-$(date +%s)-$RANDOM"
page=desktop-engine-check
body=$(printf '# Desktop engine check\n\nnonce %s\n\n=> urb://~wep/other Another page\n=> notes/more A relative link\n' "$nonce")
status=$(curl -s -m 60 -o /dev/null -w '%{http_code}' -H "$cookie" \
  -X POST "$URL/apps/lattice/save?path=$page" --data-binary "$body")
[ "$status" = 200 ] || { echo "FAIL  publishing $page answered $status"; exit 1; }
echo "published urb://~wep/$page ($nonce)"

# a fresh ship needs about 110 s before it answers a new peer promptly
# (urb-fetch core/ci/settle.mjs)
left=$((110 - ($(date +%s) - reset_at)))
if [ "$left" -gt 0 ]; then
  echo "settling ${left}s"
  sleep "$left"
fi

cd "$repo/desktop"
sh scripts/mesa-deps.sh >/dev/null
LATTICE_FLEET=1 FLEET_PAGE="urb://~wep/$page" FLEET_NONCE="$nonce" \
  cargo test engine_reads_a_fleet_page -- --ignored --nocapture
