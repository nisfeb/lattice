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

# ── mesa (remote-scry publish, docs D1) — PENDING A2 ─────────────────────────
# The lattice publish side now grows /pub/page/<name>/<rev> and
# /pub/index/<seq> bindings on every save/delete, but the live %grubbery desk
# cannot load feat/scry-io yet (state-migration blocker), so the routes below
# do not exist on a deployed ship and a keen self-read has no namespace to
# answer from. Once A2 lands (feat/scry-io deployed under the nuke-and-restart
# policy), run with LATTICE_MESA=1 to enable; until then this block is skipped
# and the script's default behavior is unchanged.
if [ "${LATTICE_MESA:-0}" = 1 ]; then
  # backfill answers and reports a count
  r=$(post "/apps/lattice/pub-regrow")
  echo "$r" | grep -q '"ok":true' && ok "pub-regrow answers ok" || bad "pub-regrow answers ok" "$r"
  echo "$r" | grep -q '"grown":' && ok "pub-regrow reports a grown count" || bad "pub-regrow grown count" "$r"
  # a publish must land a namespace binding readable by keen (self-read).
  # Dojo probe (needs the tyr MCP dojo harness; sketch, unverified until A2):
  #   post page-save + page-share for api-lc/mesa, then from the dojo:
  #     -keen /=//=/g/~tyr/grubbery/1/pub/page/api-lc/mesa/<rev>
  #   expect a %gmi page carrying the body, and after page-del a tombstone.
  #   The /pub/index/<seq> binding should carry the manifest-gmi listing.
  #   The spar path the READER builds is +keen-path: the vane letter first
  #   (ames prepends ship/rift/life itself), i.e.
  #     /g/x/1/grubbery/1/pub/page/api-lc/mesa/<rev>
  bad "mesa keen self-read" "not implemented — needs A2 on the live desk"

  # ── READ side (phase C): scry-first cross-ship reads ──────────────────────
  # Nothing here is runnable on ONE ship. A %keen is answered by ANOTHER
  # ship's kernel, and +read-page-scry deliberately bails when publisher ==
  # our (keening ourselves would be a round trip through ames to read a grub
  # sitting in this pier), so there is no single-ship path that touches the
  # converted code at all. This is the two-ship procedure Phase D runs, and it
  # is written down here rather than faked with a curl that proves nothing.
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
  #      Sweep 2 is the entire Phase C claim: an unchanged peer page is read
  #      out of the namespace and the peer's %grubbery never runs.
  #   4. edit the page on ~peer, let a sweep run: the peer's manifest hash
  #      moved, so the crawler must FALL BACK (peeks>0) and pick up the new
  #      body — /catalog-list must show the new title, not the old one.
  #   5. delete the page on ~peer: it leaves the manifest, so the rev note
  #      must be pruned alongside the catalog rows (+catalog-scan-peer's
  #      prune). A note outliving its page would keen a tombed spur and eat a
  #      full +mesa-timeout every sweep forever.
  #   6. the case that MUST NOT regress: a peer that publishes but never grew
  #      bindings (an old lattice, or one that skipped /pub-regrow). Follow
  #      such a ship and sweep repeatedly. Its first warm sweep pays three
  #      +mesa-timeouts, then +mesa-strikes retires it and every later sweep
  #      costs exactly what it cost before the mirror existed. If sweeps of
  #      that peer keep getting slower, the strike-out is broken.
  #   7. stop ~peer entirely and sweep: this bails at the manifest read
  #      (+read-pub-index-remote answers ~ and the peer is skipped), so it
  #      exercises no keen at all — it should look exactly as it does today.
  #
  # Counter caveat: keens/peeks exist only in that ~& line. No route exposes
  # them, so this is a log-reading check. If Phase D wants it automated,
  # surface the pair on a route first.
  bad "mesa scry-first peer reads" "not implemented — needs A2 AND a second ship (phase D)"

  # NOT converted, and not pending: /fetch, the web reader and the /x/
  # explorer stay on peek-remote (no rev is knowable in a per-request fiber —
  # see the comment on +read-page-body), and every write path (comments,
  # /remote-save, share notices) stays on the weir-gated poke by design.
  # Their existing checks above cover them unchanged.

  # ── SUBSCRIPTION leg (mesa D2): pointer waves + keen ──────────────────────
  # The publisher half is proven single-ship (the /pub/note/ptr pointer and
  # its seq are readable via a scratch-desk generator after page-share /
  # page-del — see the D2 commit). The SUBSCRIBER half cannot be: a wave is
  # pushed by ANOTHER ship's %grubbery and the keen it triggers is answered
  # by that ship's kernel. Two-ship procedure (with ~peer running this same
  # overlay):
  #   1. on ~peer: page-save + page-share a page P.
  #   2. on this ship: POST /sub?url=urb://~peer/P (the /sub/pages fiber arms
  #      BOTH keeps: /page on the vault grub, /note on the publish pointer).
  #   3. edit P on ~peer. Expect on this ship: the page wave carries P's new
  #      cass, the fiber keens /pub/page/P/<rev> (publisher log shows NO
  #      lattice peek; catalog shows the new body), then the note wave lands
  #      and only bumps the remembered seq (no second index).
  #   4. on ~peer edit a DIFFERENT shared page twice, then edit P: the seq
  #      the next note carries jumps by >1 relative to this ship's memory of
  #      it ONLY if waves were dropped — force that by pausing this ship —
  #      and the fiber must answer with a full +catalog-scan-peer resweep.
  #   5. page-del P on ~peer: the %del pointer must drop P's catalog rows
  #      here (search stops finding it) without waiting for a sweep.
  #   6. the mixed-fleet floor: repeat 2-3 against a peer WITHOUT the
  #      overlay — no /pub/note exists, the note keep stays silent, and every
  #      edit must land exactly as before over the peek path.
fi

echo
if [ $fails = 0 ]; then echo "all checks passed"; else echo "$fails FAILURES"; exit 1; fi
