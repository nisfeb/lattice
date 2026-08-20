#!/usr/bin/env bash
# Regenerate scripts/route-list.txt from the reader's route switch.
#
# Run this after ADDING or REMOVING a route, never as part of a refactor: the
# point of the checked-in list is that route-smoke.sh compares the same set of
# routes before and after a restructure. Regenerating mid-refactor would hide
# exactly the regression the fingerprint exists to catch.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$HERE/../grubbery-overlay/nex/lattice/app.hoon"
OUT="$HERE/route-list.txt"
grep -oE "\[%'(GET|POST|PUT|DELETE)' %[a-z0-9-]+\]" "$APP" \
  | sed "s/\[%'//; s/' %/ /; s/\]//" \
  | sort -u > "$OUT"
echo "wrote $OUT ($(grep -c '' "$OUT") routes)"
