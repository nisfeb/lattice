#!/usr/bin/env bash
# Call the local ~zod MCP server via JSON-RPC.
# Reads the session cookie from ../.mcp.json (must match the registered server).
#
# Usage: scripts/mcp-zod.sh <tool-name> [json-args]
# Example:
#   scripts/mcp-zod.sh get-our-id
#   scripts/mcp-zod.sh list-files '{"desk":"lattice","path":"/lib"}'
#
# Returns the raw JSON-RPC response. Pipe through jq to extract.
set -euo pipefail

TOOL="${1:-}"
if [ -z "$TOOL" ]; then
  echo "Usage: $0 <tool-name> [json-args]" >&2
  exit 64
fi
ARGS="${2-}"
if [ -z "$ARGS" ]; then ARGS='{}'; fi

# Locate .mcp.json — walk up from this script's directory.
HERE="$(cd "$(dirname "$0")" && pwd)"
MCPJSON=""
DIR="$HERE"
while [ "$DIR" != "/" ]; do
  if [ -f "$DIR/.mcp.json" ]; then MCPJSON="$DIR/.mcp.json"; break; fi
  DIR="$(dirname "$DIR")"
done
if [ -z "$MCPJSON" ]; then
  echo "no .mcp.json found above $HERE" >&2
  exit 65
fi

URL=$(jq -r '.mcpServers.zod.url' "$MCPJSON")
COOKIE=$(jq -r '.mcpServers.zod.headers.Cookie' "$MCPJSON")

PAYLOAD=$(jq -nc --arg name "$TOOL" --argjson args "$ARGS" \
  '{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:$name,arguments:$args}}')

curl -sS -X POST "$URL" \
  -H "Cookie: $COOKIE" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d "$PAYLOAD"
