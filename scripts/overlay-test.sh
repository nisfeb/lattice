#!/usr/bin/env bash
# Run the lattice nexus's Hoon unit tests against the running ~zod fakezod (via
# the MCP server; see scripts/mcp-zod.sh). Assumes the grubbery-overlay has been
# synced into the ship's grubbery desk (scripts/sync-overlay.sh). Commits the
# grubbery desk, runs /tests, and exits non-zero on any failure.
#
# Usage: scripts/overlay-test.sh [path-prefix]   (default: /tests/lib)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PREFIX="${1:-/tests/lib}"

"$HERE/mcp-zod.sh" commit-desk '{"desk":"grubbery"}' >/dev/null

OUT="$("$HERE/mcp-zod.sh" run-tests "{\"desk\":\"grubbery\",\"path\":\"$PREFIX\"}")"
RESULTS="$(printf '%s' "$OUT" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("result",{}).get("content",[{}])[0].get("text",""))')"
echo "$RESULTS"
if printf '%s' "$RESULTS" | grep -q 'FAILED'; then
  echo "nexus tests FAILED" >&2
  exit 1
fi
echo "nexus tests passed"
