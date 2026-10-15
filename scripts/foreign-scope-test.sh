#!/usr/bin/env bash
# foreign-scope-test.sh: verify key web-scope gates for remote-save, browse,
# browse-file, and fetch. Single-ship DENIAL cases run against ~mec alone.
# The 2-ship SUCCESS path (ship B shares-for-edit, real write lands) is
# documented as comments and must be run by the controller.
#
# ── 2-SHIP SUCCESS PATH (controller) ──────────────────────────────────────
#
#  Start a second ship (~bus) in the hoon-development fleet:
#
#    fleet new --pier ~/fleet/piers/bus --ship ~bus
#    fleet start bus
#
#  On ~bus: grant ~mec read+write access to /apps/lattice/pub/x:
#
#    curl -s -H "$CK_BUS" -X POST \
#      "http://localhost:8081/apps/lattice/share-group-save?name=mec-rw" \
#      -H 'content-type: application/json' \
#      -d '{"ships":["~mec"],"peek":["/apps/lattice/pub"],"make":["/apps/lattice/pub/x"]}'
#
#  On ~mec: mint a key with web=%some granting ~bus read=[/x] write=[/x/out]:
#    (replace ~bus and ~mec with actual patp if different)
#
#    TOK=$(curl -s -H "$CK_MEC" -X POST \
#      "http://localhost:8080/apps/lattice/key-mint" \
#      -H 'content-type: application/json' \
#      -d '{"name":"t5-success","by":"test","scope":{"web":{"some":{"~bus":{"read":["/x"],"write":["/x/out"]}}}}}' \
#      | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')
#
#  Assert remote-save to granted path succeeds (200):
#    is "remote-save to granted path" 200 $(curl -s -o /dev/null -w '%{http_code}' \
#      -X POST -H "Authorization: Bearer $TOK" \
#      "http://localhost:8080/apps/lattice/remote-save?ship=~bus&path=/x/out/file" \
#      --data-binary 'hello world')
#
#  Assert fetch of granted page succeeds (200 or 404 if page absent — not 403):
#    code=$(curl -s -o /dev/null -w '%{http_code}' \
#      -H "Authorization: Bearer $TOK" \
#      "http://localhost:8080/apps/lattice/fetch?url=urb://~bus/x/page")
#    [ "$code" != 403 ] && echo "ok - fetch granted path (got $code)" \
#      || echo "FAIL - fetch granted path returned 403"
#
#  Cleanup: fleet stop bus; fleet destroy bus
#
# ── END 2-SHIP SUCCESS PATH ────────────────────────────────────────────────
#
# Usage:  scripts/foreign-scope-test.sh
# Env:    LATTICE_URL     ship base (default http://localhost:8080)
#         LATTICE_COOKIE  session cookie file (default ~/.config/lattice-fs/cookie)

set -uo pipefail

. "$(dirname "${BASH_SOURCE[0]}")/lib/matrix.sh"
need_cookie

code(){ curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "==> mint a scoped key: web=%some ~bus read=[/x] write=[/x/out]"

MINT_JSON='{"name":"t5-deny","by":"t5test","scope":{"web":{"some":{"~bus":{"read":["/x"],"write":["/x/out"]}}}}}'
MINT_RESP=$(curl -s -H "$CK" -X POST "$B/key-mint" \
  -H 'content-type: application/json' --data-binary "$MINT_JSON")
KEY_ID=$(printf '%s' "$MINT_RESP" | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])' 2>/dev/null || true)

if [ -z "$KEY_ID" ]; then
  echo "  FAIL - could not mint key: $MINT_RESP"
  finish
fi

AUTH="Authorization: Bearer $KEY_ID"
echo "  ok   - minted key (token prefix: ${KEY_ID:0:8}…)"

echo ""
echo "==> remote-save denial cases (ship not in scope / path not in write-set)"

# ~bus path not in write-set (/x/other is not under /x/out)
is "remote-save ~bus /x/other -> 403" 403 \
  "$(code -X POST -H "$AUTH" "$B/remote-save?ship=~bus&path=/x/other/f" \
    --data-binary 'test')"

# ~dev not in scope at all
is "remote-save ~dev /x -> 403" 403 \
  "$(code -X POST -H "$AUTH" "$B/remote-save?ship=~dev&path=/x/f" \
    --data-binary 'test')"

echo ""
echo "==> fetch denial cases (ship not in scope / path not in read-set)"

# ~dev not in scope
is "fetch ~dev /x -> 403" 403 \
  "$(code -H "$AUTH" "$B/fetch?url=urb://~dev/x/page")"

# ~bus path not in read-set
is "fetch ~bus /y -> 403" 403 \
  "$(code -H "$AUTH" "$B/fetch?url=urb://~bus/y/page")"

echo ""
echo "==> browse denial cases"

is "browse ~dev /x -> 403" 403 \
  "$(code -H "$AUTH" "$B/browse?ship=~dev&path=/x")"

is "browse ~bus /y -> 403" 403 \
  "$(code -H "$AUTH" "$B/browse?ship=~bus&path=/y")"

echo ""
echo "==> browse-file denial cases"

is "browse-file ~dev /x/f -> 403" 403 \
  "$(code -H "$AUTH" "$B/browse-file?ship=~dev&path=/x/f")"

is "browse-file ~bus /y/f -> 403" 403 \
  "$(code -H "$AUTH" "$B/browse-file?ship=~bus&path=/y/f")"

echo ""
echo "==> cleanup: revoke the test key"
KEY_KID=$(printf '%s' "$MINT_RESP" | python3 -c 'import json,sys;print(json.load(sys.stdin)["key"]["id"])' 2>/dev/null || true)
if [ -n "$KEY_KID" ]; then
  curl -s -o /dev/null -H "$CK" -X POST "$B/key-revoke?id=$KEY_KID"
  echo "  ok   - key revoked"
fi

finish
