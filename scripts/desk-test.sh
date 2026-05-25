#!/usr/bin/env bash
# Run the %lattice desk's Hoon unit tests against the running ~zod fakezod
# (via the MCP server; see scripts/mcp-zod.sh). Assumes desk/ is synced to the
# ship's pier. Commits the desk, runs /tests, and exits non-zero on any failure.
#
# Usage: scripts/desk-test.sh [path-prefix]   (default: /tests)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PREFIX="${1:-/tests}"

"$HERE/mcp-zod.sh" commit-desk '{"desk":"lattice"}' >/dev/null

OUT="$("$HERE/mcp-zod.sh" run-tests "{\"desk\":\"lattice\",\"path\":\"$PREFIX\"}")"
RESULTS="$(printf '%s' "$OUT" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("result",{}).get("content",[{}])[0].get("text",""))')"
echo "$RESULTS"
if printf '%s' "$RESULTS" | grep -q 'FAILED'; then
  echo "desk tests FAILED" >&2
  exit 1
fi
echo "desk tests passed"
