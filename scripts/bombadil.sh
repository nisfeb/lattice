#!/usr/bin/env bash
# Autonomous property-based UI exploration via bombadil (antithesishq/bombadil).
#
# Points bombadil at the OWNER session of a dev ship's lattice app and lets it
# click everything. Owner session means it WILL create/delete/share content —
# that is the point, and why the target defaults to tyr and must never be
# production. Install: see https://antithesishq.github.io/bombadil/
#
# Usage: scripts/bombadil.sh [minutes] [output-dir]
#   cookie: ~/.config/lattice-fs/cookie (tyr). Override with LATTICE_COOKIE_FILE.
#   base:   http://localhost:8080 (tyr). Override with LATTICE_URL.
#
# Reading results: trace.jsonl has one event per interaction with per-event
# `violations`; screenshots/ pairs with it. `bombadil browser inspect <dir>`
# is the interactive TUI. A "navigation timed out" abort is itself a finding —
# it means a click pushed tail latency past 30s (the pier serializes requests,
# so bursts compound; see docs/perf-review.md).
set -euo pipefail
MIN="${1:-5}"
OUT="${2:-/tmp/bombadil-lattice-$(date +%s)}"
BASE="${LATTICE_URL:-http://localhost:8080}"
CK="$(cat "${LATTICE_COOKIE_FILE:-$HOME/.config/lattice-fs/cookie}")"
case "$BASE" in
  *sneagan.com*|*ricsul*) echo "refusing: that looks like production" >&2; exit 66;;
esac
exec bombadil browser test "$BASE/apps/lattice/app" \
  --header "Cookie=$CK" \
  --time-limit "${MIN}m" --headless --no-sandbox \
  --output-path "$OUT"
