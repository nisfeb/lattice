#!/usr/bin/env bash
# Autonomous property-based UI exploration via bombadil (antithesishq/bombadil).
#
# Points bombadil at the OWNER session of a dev ship's lattice app and lets it
# click everything. Owner session means it WILL create/delete/share content —
# that is the point, and why the target defaults to tyr and must never be
# production. Install: see https://antithesishq.github.io/bombadil/
#
# Runs with scripts/bombadil-spec.js unless LATTICE_SPEC says otherwise: the
# spec steers exploration into the sharing flow (grants to ~nec) and adds
# lattice properties (shared-with-me dedupe, saving/granting resolve <30s).
#
# Usage: scripts/bombadil.sh [minutes] [output-dir]
#   cookie: ~/.config/lattice-fs/cookie (tyr). Override with LATTICE_COOKIE_FILE.
#   base:   http://localhost:8080 (tyr). Override with LATTICE_URL.
#   spec:   scripts/bombadil-spec.js. Override with LATTICE_SPEC ("" = defaults only).
#
# Server-state oracle: bombadil only sees the DOM, but our worst failures are
# server-side (weir widened, evaluator fiber crash, body emptied). So this
# wrapper snapshots share-groups + page-tree before, re-probes after, and
# prints the drift. A page-tree diff is EXPECTED (the fuzzer creates/deletes
# pages as owner); the share-groups diff is the one to actually read — it is
# every grant the run manufactured. A failed post-run probe means the
# evaluator is likely down: stop and look at the ship before anything else.
#
# Reading results: each attempt writes $OUT/run-N/ with trace.jsonl (one
# event per interaction, per-event `violations`) and screenshots/.
# `bombadil browser inspect <run-dir>` is the interactive TUI. Exit 2 =
# property violation(s) in any attempt.
#
# Why attempts, plural: bombadil hard-aborts when a navigation exceeds 30s,
# and the pier gets there honestly — /catalog-sweep blocks ~21s before
# acking (measured on tyr, despite its "background" claim) and the pier
# serializes everything behind it (docs/perf-review.md). Each abort is
# logged as the latency finding it is, and the run relaunches with the
# remaining time budget instead of forfeiting it.
set -euo pipefail
MIN="${1:-5}"
OUT="${2:-/tmp/bombadil-lattice-$(date +%s)}"
BASE="${LATTICE_URL:-http://localhost:8080}"
CK="$(cat "${LATTICE_COOKIE_FILE:-$HOME/.config/lattice-fs/cookie}")"
SPEC="${LATTICE_SPEC-$(dirname "$0")/bombadil-spec.js}"
case "$BASE" in
  *sneagan.com*|*ricsul*) echo "refusing: that looks like production" >&2; exit 66;;
esac

API="$BASE/apps/lattice"
mkdir -p "$OUT"
curl -sf -H "Cookie: $CK" "$API/share-groups" -o "$OUT/share-groups.before" \
  || { echo "pre-run probe failed: $API/share-groups — is the ship up?" >&2; exit 65; }
curl -sf -H "Cookie: $CK" "$API/page-tree" -o "$OUT/page-tree.before" \
  || { echo "pre-run probe failed: $API/page-tree" >&2; exit 65; }

DEADLINE=$(( $(date +%s) + MIN * 60 ))
N=0 VIOL=0
while :; do
  LEFT=$(( DEADLINE - $(date +%s) ))
  [ "$LEFT" -ge 30 ] || break
  N=$(( N + 1 ))
  set +e
  bombadil browser test "$BASE/apps/lattice/app" ${SPEC:+"$SPEC"} \
    --header "Cookie=$CK" \
    --time-limit "${LEFT}s" --headless --no-sandbox \
    --output-path "$OUT/run-$N"
  RC=$?
  set -e
  [ "$RC" -eq 2 ] && VIOL=1
  [ "$RC" -eq 0 ] && break
  echo "attempt $N died (exit $RC) — a navigation stalled past 30s behind the pier queue; relaunching" >&2
done
echo "attempts: $N, violations: $VIOL"

echo "--- post-run health"
if curl -sf -H "Cookie: $CK" "$API/page-tree" -o "$OUT/page-tree.after"; then
  echo "page-tree: 200, evaluator alive"
else
  echo "HEALTH FAIL: page-tree unreachable — evaluator may have crashed; check the ship" >&2
  exit 70
fi
curl -sf -H "Cookie: $CK" "$API/share-groups" -o "$OUT/share-groups.after" || true

echo "--- share-groups drift (grants the run manufactured — READ THIS)"
diff -u "$OUT/share-groups.before" "$OUT/share-groups.after" && echo "(none)" || true

echo "--- page-tree drift (expected: the fuzzer is the owner)"
python3 - "$OUT" <<'EOF'
import json, sys
d = sys.argv[1]
def paths(f):
    try:
        j = json.load(open(f"{d}/page-tree.{f}"))
        return {n.get("path") for n in j.get("nodes", []) if isinstance(n, dict)}
    except Exception as e:
        print(f"  ({f}: unparseable — {e})"); return set()
b, a = paths("before"), paths("after")
for p in sorted(a - b): print(f"  + {p}")
for p in sorted(b - a): print(f"  - {p}")
print(f"  {len(a - b)} added, {len(b - a)} removed, {len(b & a)} kept")
EOF

[ "$VIOL" -eq 1 ] && exit 2
exit 0
