#!/usr/bin/env bash
# Route characterization harness for the lattice nexus.
#
# Records the HTTP status of every route in +handle-request's switch. This is
# not a correctness test, it is a before/after fingerprint. Restructuring the
# router must not change any status, and the failure this exists to catch is a
# route that quietly falls through to the 404 default because its case ended up
# in an arm that never runs.
#
# The route names live in scripts/route-list.txt, regenerated from app.hoon by
# scripts/route-list.sh. They are a checked-in data file rather than a run-time
# grep so the fingerprint stays stable while app.hoon is being restructured,
# which is the whole point of a characterization test.
#
# Usage:  LATTICE_URL=http://localhost:8081 LATTICE_COOKIE=/path/to/cookie \
#           scripts/route-smoke.sh > before.txt
#         (refactor)
#         LATTICE_URL=... LATTICE_COOKIE=... scripts/route-smoke.sh > after.txt
#         diff before.txt after.txt   # must be empty
#
# Run it against a THROWAWAY ship. Requests carry no parameters, so handlers
# reject them before mutating, but a few (catalog-sweep, search-reindex) do
# real background work.
set -u
URL="${LATTICE_URL:-http://localhost:8081}"; URL="${URL%/}"
CKF="${LATTICE_COOKIE:?set LATTICE_COOKIE to a file holding the urbauth cookie}"
CK="Cookie: $(cat "$CKF")"
HERE="$(cd "$(dirname "$0")" && pwd)"
LIST="${ROUTE_LIST:-$HERE/route-list.txt}"
[ -r "$LIST" ] || { echo "no route list at $LIST" >&2; exit 66; }

# Routes that DO something and are not idempotent: their status legitimately
# differs between runs, so a status here would make the fingerprint flap and
# train you to ignore real diffs. They are still called (reachability is what
# is being checked) but reported as `mutating`, not as a code.
#
# pub-reconcile earned its place the hard way: it is one-shot behind a marker
# grub, and on a ship where that marker did not stick, every later call re-culls
# already-culled seqs and 500s. The first run of this harness is what exposed
# that, which is worth knowing before you read a diff here as a refactor bug.
NOIDEM=" pub-reconcile pub-regrow pub-prune catalog-sweep catalog-init catalog-scan-self
 search-reindex know-reindex know-prune history-clear legacy-dismiss legacy-migrate "

# the bare app root, which the switch reaches as an empty suffix
printf '%-4s %-24s %s\n' GET '(root)' \
  "$(curl -s -o /dev/null -w '%{http_code}' -m 25 -H "$CK" "$URL/apps/lattice")"

while read -r meth name; do
  [ -n "${meth:-}" ] && [ -n "${name:-}" ] || continue
  case "$meth" in '#'*) continue ;; esac
  u="$URL/apps/lattice/$name"
  if [ "$meth" = GET ]; then
    code=$(curl -s -o /dev/null -w '%{http_code}' -m 25 -H "$CK" "$u")
  else
    code=$(curl -s -o /dev/null -w '%{http_code}' -m 25 -X "$meth" -H "$CK" "$u")
  fi
  case "$NOIDEM" in
    *" $name "*)
      # 404 still fails loudly: that means the route stopped being reachable,
      # which is the regression this harness is for.
      [ "$code" = 404 ] || code=mutating ;;
  esac
  printf '%-4s %-24s %s\n' "$meth" "$name" "$code"
done < "$LIST"
