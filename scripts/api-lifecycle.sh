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

# ── mesa (remote-scry publish, docs D1), PENDING A2 ──────────────────────────
# The lattice publish side grows /pub/page/<name>/<rev> and /pub/index/<seq>
# bindings on every save/delete. The live %grubbery desk cannot load
# feat/scry-io yet (state-migration blocker). The routes below therefore do
# not exist on a deployed ship, and a keen self-read has no namespace to
# answer from. Once A2 lands (feat/scry-io deployed under the nuke-and-restart
# policy), run with LATTICE_MESA=1 to enable. Until then this block is
# skipped.
if [ "${LATTICE_MESA:-0}" = 1 ]; then
  # backfill answers and reports a count
  r=$(post "/apps/lattice/pub-regrow")
  echo "$r" | grep -q '"ok":true' && ok "pub-regrow answers ok" || bad "pub-regrow answers ok" "$r"
  echo "$r" | grep -q '"grown":' && ok "pub-regrow reports a grown count" || bad "pub-regrow grown count" "$r"
  # a publish must land a namespace binding readable by keen. The spar path
  # the reader builds is +keen-path. Note the EMPTY SEGMENT after the agent
  # name. It is load-bearing. Without it gall routes into the agent's
  # +on-peek instead of the scry farm, and the keen parks forever. The path:
  #     /g/x/1/grubbery//1/pub/page/api-lc/mesa/<rev>
  # From a peer's dojo (a keen is answered by the OTHER ship's kernel):
  #     -keen [~tyr /g/x/1/grubbery//1/pub/page/api-lc/mesa/<rev>]
  #   expect a [%gmi body] page. After page-del, a keen at the NEXT cass
  #   (rev+1) answers the [%del ''] tombstone the delete grew.
  bad "mesa keen read" "manual: two-ship dojo probe (see path note above)"

  # ── READ side (phase C): scry-first cross-ship reads ──────────────────────
  # Nothing here is runnable on ONE ship. A %keen is answered by ANOTHER
  # ship's kernel, and +read-page-scry deliberately bails when publisher ==
  # our (keening ourselves would be a round trip through ames to read a grub
  # sitting in this pier). No single-ship path touches the converted code.
  # This is the two-ship procedure Phase D runs. Do not fake it with a
  # single-ship curl check.
  #
  #   1. on ~peer (running the same lattice + feat/scry-io):
  #        page-save api-lc/mesa, page-share it.
  #   2. on this ship: POST /follow?ship=~peer, then POST /catalog-sweep.
  #      That route runs COLD by design (a request fiber keeps no cache), so
  #      it must peek everything. The interesting sweeps are the crawler's.
  #   3. wait for two /crawler.sig ticks (or shorten ~h6 locally) and read the
  #      pier log for the per-peer, per-sweep split:
  #        [%lattice-mesa-scry ~peer keens=0 peeks=N]   <- sweep 1, cold
  #        [%lattice-mesa-scry ~peer keens=N peeks=0]   <- sweep 2, warm
  #      Sweep 2 is the entire Phase C claim. An unchanged peer page is read
  #      out of the namespace and the peer's %grubbery never runs.
  #   4. edit the page on ~peer and let a sweep run. The peer's manifest hash
  #      moved, so the crawler must FALL BACK (peeks>0) and pick up the new
  #      body. /catalog-list must show the new title, not the old one.
  #   5. delete the page on ~peer. It leaves the manifest, so the rev note
  #      must be pruned alongside the catalog rows (+catalog-scan-peer's
  #      prune). A note outliving its page would keen a tombed spur and eat a
  #      full +mesa-timeout every sweep forever.
  #   6. the documented cost against a peer that publishes but never grew
  #      bindings (an old lattice, or one that skipped /pub-regrow): each
  #      warm sweep of an unchanged page pays one ~s10 +mesa-timeout before
  #      the peek fallback. There is deliberately NO strike-out. The cost
  #      recurs every sweep, bounded by the peer budget. If that bites,
  #      /pub-regrow on the peer (or unfollow) is the remedy.
  #   7. stop ~peer entirely and sweep. This bails at the manifest read
  #      (+read-pub-index-remote answers ~ and the peer is skipped), so it
  #      exercises no keen at all.
  #
  # Counter caveat: keens/peeks exist only in that ~& line. No route exposes
  # them, so this is a log-reading check. If Phase D wants it automated,
  # surface the pair on a route first.
  bad "mesa scry-first peer reads" "manual: two-ship crawler procedure above"

  # NOT converted, and not pending: /fetch, the web reader and the /x/
  # explorer stay on peek-remote, since no rev is knowable in a per-request
  # fiber (see the comment on +read-page-body). Every write path (comments,
  # /remote-save, share notices) stays on the weir-gated poke by design.
  # The existing checks above cover them.

  # ── SUBSCRIPTION leg (mesa D2): wave -> keen ──────────────────────────────
  # The reader rides ONE keep on the peer's page gmi grub. The keep's wave
  # (the initial bond AND every edit) carries the grub's cass = the rev the
  # publisher last grew, and the fiber keens the body at exactly that rev.
  # No pointer, no seq, no peek fallback. Two-ship procedure (with ~peer
  # running this same overlay):
  #   1. on ~peer: page-save + page-share a page P.
  #   2. on this ship: POST /sub?url=urb://~peer/P. The BOND wave alone must
  #      index P here (catalog/search finds it) with NO edit on ~peer. That
  #      is the initial-bond leg.
  #   3. edit P on ~peer. Expect here: the wave carries P's new cass, the
  #      fiber keens /pub/page/P/<rev> (publisher log shows NO lattice peek),
  #      catalog shows the new body.
  #   4. reboot THIS ship, then edit P on ~peer while it is down, restart.
  #      The re-armed keep's bond wave carries the newest cass and the missed
  #      edit lands. Offline catch-up rides the same bond leg as step 2.
  #   5. page-del P on ~peer. The delete grows a [%del ''] tombstone at the
  #      post-cull cass. The wave names it, the keen here hits it, and P's
  #      catalog rows drop (search stops finding it) without waiting for a
  #      sweep. A re-save of P after that must re-index (rev keeps rising).
  #   6. the mixed-fleet limitation, BY DESIGN: subscribe to a peer that
  #      does not mirror (old lattice / never regrown). Every wave keens an
  #      unbound spur. Each wave costs one retry then a give-up (~20s in the
  #      fiber, lrev NOT advanced) and nothing is indexed. The abandoned
  #      request is %yawn-cancelled, so parked keens never pile up on the
  #      publisher. The subscription starts working the moment the peer runs
  #      /pub-regrow.
fi

echo
if [ $fails = 0 ]; then echo "all checks passed"; else echo "$fails FAILURES"; exit 1; fi
