#!/usr/bin/env bash
#  hoon-mcp.sh: one MCP tools/call against the ~nec dev ship.
#
#  The nexus speaks MCP over http. Every call here needs the session cookie and
#  the SSE-or-json Accept header the nexus insists on, which is enough
#  boilerplate that repeating it inline invites a typo that reads as a ship
#  failure. So: one place.
#
#  Usage: hoon-mcp.sh <tool> <json-args> [timeout-seconds]
#    hoon-mcp.sh mcp/test-build '{"desk":"grubbery","path":"/gub/lib/quiz/hoon"}'
#    hoon-mcp.sh mcp/run-tests  '{"desk":"grubbery","path":"/tests/lib/quiz"}'
#    hoon-mcp.sh mcp/commit-desk '{"desk":"grubbery"}' 280
#
#  NOTE the ship is http://localhost:8081 (~nec), a DISPOSABLE dev ship.
#  urbit.sneagan.com is production and must never be pointed at from here.
set -uo pipefail

SHIP="${LATTICE_SHIP:-http://localhost:8081}"
COOKIE_FILE="${LATTICE_COOKIE:-$HOME/.config/lattice-fs/nec-cookie}"
TOOL="${1:?usage: hoon-mcp.sh <tool> <json-args> [timeout]}"
ARGS="${2:-{\}}"
TMO="${3:-120}"

[ -r "$COOKIE_FILE" ] || { echo "no cookie at $COOKIE_FILE" >&2; exit 66; }

curl -s --max-time "$TMO" -X POST "$SHIP/mcp" \
  -H "Cookie: $(cat "$COOKIE_FILE")" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$TOOL\",\"arguments\":$ARGS}}"
