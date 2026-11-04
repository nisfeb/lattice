#!/usr/bin/env bash
# Real board reads through the desktop's shipless reader, on the fleet:
# claims the furum set (~rup, ~hus), resets it to its m1c-traces snapshot
# (urb-fetch traces/fixtures.sh: furum board m1c on ~rup with a post and a
# comment, lattice on ~hus with forum board m1btest), and runs the boards
# ignored test, which reads each board and its first thread as a fake moon
# (the fake network has no comets). The claim is released at the end, on
# failure too. Fake fleet ships only, never a live one.
#
# Usage:  FLEET_WHO=<you> scripts/desktop-forum-fleet.sh
# Env:    FLEET (the fleet script)
#
# Exits 0 with "skipped" when the set is claimed by someone else.
set -euo pipefail

: "${FLEET_WHO:?set FLEET_WHO to who is claiming the set}"
FLEET=${FLEET:-$HOME/software/personal/hoon-development/fleet/fleet}
SET=furum
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/.." && pwd)

holder=$("$FLEET" ls 2>/dev/null | awk -v s="$SET" '$1==s' | grep -oE '\([^)]*\)' | tr -d '()' || true)
if [ -n "$holder" ] && [ "$holder" != "$FLEET_WHO" ]; then
  echo "skipped: $SET is claimed by $holder"
  exit 0
fi
"$FLEET" claim "$SET" "$FLEET_WHO"
cleanup() {
  "$FLEET" down "$SET" >/dev/null 2>&1 || true
  "$FLEET" release "$SET" || true
}
trap cleanup EXIT

"$FLEET" reset "$SET" m1c-traces
reset_at=$(date +%s)

cd "$repo/desktop"
sh scripts/mesa-deps.sh >/dev/null
# build while the ships settle
cargo test --no-run 2>/dev/null

# a fresh ship needs about 110 s before it answers a new peer promptly
# (urb-fetch core/ci/settle.mjs)
left=$((110 - ($(date +%s) - reset_at)))
if [ "$left" -gt 0 ]; then
  echo "settling ${left}s"
  sleep "$left"
fi

# each board, and text its first thread shows ('+' for a space)
LATTICE_FLEET=1 FLEET_PARENT='~rup' \
  FLEET_BOARDS="urb://~rup/furum/m1c|the+host+comments ${FLEET_FORUM:-urb://~hus/forum/m1btest|Reply}" \
  cargo test the_reader_reads_fleet_boards -- --ignored --nocapture
