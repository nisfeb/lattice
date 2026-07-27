#!/usr/bin/env bash
# MCP knowledge-tool matrix: drives all eleven in-ball lattice-* tools over
# JSON-RPC at /grubbery/mcp, end to end on one scratch key. This is the
# contract every agent's memory store depends on; platform.md marks it
# must-not-regress. Run against the tyr harness, never production.
#
# Usage:  scripts/mcp-matrix.sh
# Env:    LATTICE_URL     ship base (default http://localhost:8080)
#         LATTICE_COOKIE  cookie file (default ~/.config/lattice-fs/cookie)
set -uo pipefail

URL="${LATTICE_URL:-http://localhost:8080}"; URL="${URL%/}"
CKF="${LATTICE_COOKIE:-$HOME/.config/lattice-fs/cookie}"
CK="Cookie: $(cat "$CKF")"
MCP="$URL/grubbery/mcp"
K="mcpmx/$$"

fail=0
ok()  { echo "  ok   - $1"; }
bad() { echo "  FAIL - $1${2:+ ($2)}"; fail=1; }
has() { if printf '%s' "$3" | grep -qF -- "$2"; then ok "$1"; else bad "$1" "no '$2' in: $(printf '%s' "$3" | head -c 140)"; fi; }
hasnt(){ if printf '%s' "$3" | grep -qF -- "$2"; then bad "$1" "unexpected '$2'"; else ok "$1"; fi; }

# tool <name> <json-args>  -> the tool's text result on stdout
tool() {
  python3 - "$1" "$2" <<'PY' > /tmp/mcpmx-req.$$
import json,sys
print(json.dumps({"jsonrpc":"2.0","id":1,"method":"tools/call",
  "params":{"name":sys.argv[1],"arguments":json.loads(sys.argv[2])}}))
PY
  curl -s -m 30 -X POST "$MCP" -H "$CK" -H 'Content-Type: application/json' \
    --data-binary @/tmp/mcpmx-req.$$ \
  | python3 -c 'import json,sys
r=json.load(sys.stdin)
print(r.get("result",{}).get("content",[{}])[0].get("text", "RPC-ERROR: "+json.dumps(r.get("error"))))'
  rm -f /tmp/mcpmx-req.$$
}

echo "==> save / read / list / search"
has "lattice-save"   "saved"            "$(tool lattice-save "{\"key\":\"$K\",\"body\":\"mcp matrix memory body\"}")"
has "lattice-read"   "mcp matrix memory body" "$(tool lattice-read "{\"key\":\"$K\"}")"
has "lattice-list"   "$K"               "$(tool lattice-list '{}')"
has "lattice-search body" "$K"          "$(tool lattice-search '{"query":"mcp matrix memory"}')"
has "lattice-search key"  "$K"          "$(tool lattice-search '{"query":"mcpmx"}')"

echo "==> tags: tag / tags / explore / untag"
has "lattice-tag"    "tagged"       "$(tool lattice-tag "{\"key\":\"$K\",\"tag\":\"MCPMX-TAG\"}")"
has "tags case-fold in read" "mcpmx-tag" "$(tool lattice-read "{\"key\":\"$K\"}")"
has "lattice-tags vocabulary" "mcpmx-tag" "$(tool lattice-tags '{}')"
has "lattice-explore by tag" "$K"       "$(tool lattice-explore '{"tag":"mcpmx-tag"}')"
has "lattice-untag"  "mcpmx-tag"        "$(tool lattice-untag "{\"key\":\"$K\",\"tag\":\"mcpmx-tag\"}")"
hasnt "tag gone after untag" "mcpmx-tag" "$(tool lattice-read "{\"key\":\"$K\"}")"

echo "==> move (history-preserving rename)"
has "lattice-move"   "moved"            "$(tool lattice-move "{\"key\":\"$K\",\"to\":\"$K-moved\"}")"
has "body at new key" "mcp matrix memory body" "$(tool lattice-read "{\"key\":\"$K-moved\"}")"
hasnt "old key gone from list" "\"$K\"" "$(tool lattice-list '{}' | python3 -c 'import json,sys
d=json.loads(sys.stdin.read())
print(json.dumps([k["key"] for k in d["keys"]]))')"

echo "==> delete / restore / re-save restores"
has "lattice-delete" "deleted"          "$(tool lattice-delete "{\"key\":\"$K-moved\"}")"
has "read after delete errors" "not found" "$(tool lattice-read "{\"key\":\"$K-moved\"}")"
has "lattice-restore" "restored"        "$(tool lattice-restore "{\"key\":\"$K-moved\"}")"
has "body back after restore" "mcp matrix memory body" "$(tool lattice-read "{\"key\":\"$K-moved\"}")"
has "delete again"   "deleted"          "$(tool lattice-delete "{\"key\":\"$K-moved\"}")"
has "re-save a deleted key" "saved"     "$(tool lattice-save "{\"key\":\"$K-moved\",\"body\":\"second life\"}")"
has "re-saved body serves" "second life" "$(tool lattice-read "{\"key\":\"$K-moved\"}")"

echo "==> cleanup"
has "final delete"   "deleted"          "$(tool lattice-delete "{\"key\":\"$K-moved\"}")"
hasnt "scratch key gone" "$K"           "$(tool lattice-list '{}')"

echo
if [ "$fail" = 0 ]; then echo "mcp-matrix PASSED"; else echo "mcp-matrix FAILED"; fi
exit "$fail"
