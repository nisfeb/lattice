#!/usr/bin/env bash
#  api-lifecycle.sh — server-side write/share/publish lifecycle, pinned.
#
#  Every check here is a bug that shipped and was later caught by a review
#  pass (##173-#178): silent move clobbering, the missing no-CAS spelling,
#  deleted pages left published, moved shared pages left unpublished, the
#  'urbit' scope label privatizing restores, invalid names answered 400
#  after the client queued them. Cheap curl probes, so they can run on
#  every deploy.
#
#  WRITES to the ship (namespace api-lc/) — dev harness only.
#  Env: LATTICE_URL, LATTICE_COOKIE   (as ui-matrix.mjs)
set -u
BASE="${LATTICE_URL:-http://localhost:8080}"
CK=$(cat "${LATTICE_COOKIE/#\~/$HOME}")
fails=0
ok()   { echo "  ok   - $1"; }
bad()  { echo "  FAIL - $1 ($2)"; fails=$((fails+1)); }
post() { curl -s -m 60 -X POST -H "Cookie: $CK" "$BASE$1" ${2:+-d "$2"}; }
code() { curl -s -m 60 -X POST -H "Cookie: $CK" -o /dev/null -w '%{http_code}' "$BASE$1" ${2:+-d "$2"}; }
view() { curl -s -m 60 -H "Cookie: $CK" "$BASE/apps/lattice?url=urb%3A%2F%2F~tyr%2F$1&u=lc$RANDOM"; }

# settle gate: right after a deploy the pier answers at 5-10s and every
# timing-adjacent assertion below would measure churn instead of behavior
okr=0
for i in $(seq 1 40); do
  t0=$(date +%s%N)
  curl -s -m 30 -o /dev/null -H "Cookie: $CK" "$BASE/apps/lattice"
  el=$(( ($(date +%s%N) - t0) / 1000000 ))
  if [ "$el" -lt 4000 ]; then okr=$((okr+1)); [ $okr -ge 3 ] && break; else okr=0; fi
  sleep 5
done
[ $okr -lt 3 ] && { echo "ship never settled"; exit 1; }

post "/apps/lattice/page-save?name=api-lc%2Fsrc&type=md" "# src" >/dev/null
post "/apps/lattice/page-save?name=api-lc%2Fdst&type=md" "# dst" >/dev/null

c=$(code "/apps/lattice/page-move?from=api-lc%2Fsrc&to=api-lc%2Fdst")
[ "$c" = 409 ] && ok "move onto an existing page is refused" || bad "move onto an existing page is refused" "$c"
c=$(code "/apps/lattice/page-move?from=api-lc%2Fsrc&to=api-lc%2Fmoved")
[ "$c" = 200 ] && ok "move to a fresh name lands" || bad "move to a fresh name lands" "$c"

r=$(post "/apps/lattice/page-save-batch?report=1" '[{"name":"api-lc/dst","type":"md","body":"# dst base0","base":0}]')
echo "$r" | grep -q '"conflicted":false' \
  && ok "batch base 0 is a no-CAS claim (applies clean)" \
  || bad "batch base 0 is a no-CAS claim" "$r"
r=$(post "/apps/lattice/page-save-batch?report=1" '[{"name":"api-lc/dst","type":"md","body":"# dst stale","base":999}]')
echo "$r" | grep -q '"conflicted":true' \
  && ok "a genuinely stale base still conflicts (CAS intact)" \
  || bad "a genuinely stale base still conflicts" "$r"

c=$(code "/apps/lattice/page-save?name=api-lc%2FBad%20Name&type=md" "# nope")
[ "$c" = 400 ] && ok "an invalid name is refused with 400" || bad "invalid name 400" "$c"
c=$(code "/apps/lattice/page-save?name=api-lc%2Fdst&type=md&new=1" "# claim")
[ "$c" = 409 ] && ok "a create onto a taken name is refused with 409" || bad "create-claim 409" "$c"

post "/apps/lattice/page-save?name=api-lc%2Fpub&type=md" "# lifecycle pub body" >/dev/null
c=$(code "/apps/lattice/page-share?name=api-lc%2Fpub&mode=urbit")
[ "$c" = 200 ] && ok "the archive label 'urbit' is accepted as shared" || bad "urbit alias" "$c"
sleep 3
n=$(view "api-lc%2Fpub" | grep -c "lifecycle pub body")
[ "$n" -ge 1 ] && ok "a shared page serves at its urb:// key" || bad "shared page serves" "$n"

post "/apps/lattice/page-move?from=api-lc%2Fpub&to=api-lc%2Fpub2" >/dev/null
sleep 3
n=$(view "api-lc%2Fpub2" | grep -c "lifecycle pub body")
[ "$n" -ge 1 ] && ok "a MOVED shared page serves at its NEW key" || bad "moved shared page republishes" "$n"

post "/apps/lattice/page-del?name=api-lc%2Fpub2" >/dev/null
sleep 3
n=$(view "api-lc%2Fpub2" | grep -c "lifecycle pub body")
[ "$n" = 0 ] && ok "a DELETED shared page stops serving" || bad "deleted page unpublishes" "$n"

for nm in api-lc%2Fdst api-lc%2Fmoved; do
  post "/apps/lattice/page-del?name=$nm" >/dev/null
done

echo
if [ $fails = 0 ]; then echo "all checks passed"; else echo "$fails FAILURES"; exit 1; fi
