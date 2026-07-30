#!/usr/bin/env bash
# Deploy the lattice overlay to ~ricsul-bilwyt.
#
# This is NOT just a sync. Ricsul is mid-migration between two incompatible
# versions of the app, and the two halves must land in the SAME |commit:
#
#   - The app.hoon currently DEPLOYED on ricsul consumes obk-req:ast, a type that
#     exists only in the 28-line obelisk-ast.hoon stub this repo used to ship.
#   - The app.hoon in THIS repo needs grubbery's real 1208-line obelisk-ast.hoon,
#     which that stub overwrote (rsync has no --delete, so syncing cannot undo it).
#
# So restoring the AST alone breaks the running app, and syncing alone breaks the
# new one. There is no safe intermediate state, which is why this script stages
# every change and stops before the commit for a human to run it.
#
# Usage: scripts/deploy-ricsul.sh [--go]
#   no flag  dry run: report what would change, touch nothing
#   --go     stage the files on ricsul, verify, then STOP and print the |commit
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
OVERLAY="$REPO/grubbery-overlay"

RIC="sneagan@45.33.75.69"
SSH="ssh -p 4141"
RDESK="/home/sneagan/ricsul-bilwyt/_data/ricsul-bilwyt/grubbery"

# Grubbery's own obelisk-ast.hoon. A clean grubbery checkout is the correct
# source of truth: it is the file grubbery ships, not obelisk upstream's copy
# that merely happens to be identical today.
PRISTINE_AST="/home/sneagan/software/groundwire/grubbery/desk/gub/lib/obelisk-ast.hoon"
AST_MD5="9d67986c05b5942ab28d099fd72735da"

GO=0
[ "${1:-}" = "--go" ] && GO=1

say() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

say "preflight"
[ -d "$OVERLAY" ] || { echo "no overlay at $OVERLAY" >&2; exit 66; }
[ -f "$PRISTINE_AST" ] || { echo "no pristine obelisk-ast at $PRISTINE_AST" >&2; exit 67; }
got=$(md5sum "$PRISTINE_AST" | cut -d' ' -f1)
[ "$got" = "$AST_MD5" ] || { echo "pristine AST md5 $got != expected $AST_MD5" >&2; exit 68; }
echo "pristine obelisk-ast.hoon ok ($(wc -l < "$PRISTINE_AST") lines, $AST_MD5)"

# The repo must be clean and pushed: ricsul is deployed from these files, and a
# dirty tree makes "what is on the ship" unanswerable later.
cd "$REPO"
[ -z "$(git status --porcelain)" ] || { echo "repo is dirty — commit first" >&2; exit 69; }
echo "repo clean at $(git rev-parse --short HEAD)"

say "current state on ricsul"
$SSH "$RIC" "
  echo -n 'gub/lib/obelisk-ast.hoon: '; wc -l < $RDESK/gub/lib/obelisk-ast.hoon
  echo -n 'gub/nex/lattice/app.hoon: '; wc -l < $RDESK/gub/nex/lattice/app.hoon
  echo -n 'obk marcs: '; ls $RDESK/gub/mar/lattice/ | grep obk | tr '\n' ' '; echo
"

if [ "$GO" -eq 0 ]; then
  say "DRY RUN — nothing was changed"
  echo "re-run with --go to stage the deploy."
  exit 0
fi

say "staging (same six mappings as sync-overlay.sh; never add --delete)"
rsync -a -e "$SSH" "$OVERLAY/lib/"         "$RIC:$RDESK/gub/lib/"
rsync -a -e "$SSH" "$OVERLAY/lib/"         "$RIC:$RDESK/lib/"
rsync -a -e "$SSH" "$OVERLAY/nex/lattice/" "$RIC:$RDESK/gub/nex/lattice/"
rsync -a -e "$SSH" "$OVERLAY/mar/lattice/" "$RIC:$RDESK/gub/mar/lattice/"
[ -d "$OVERLAY/mar-clay" ] && rsync -a -e "$SSH" "$OVERLAY/mar-clay/" "$RIC:$RDESK/gub/mar/clay/"
rsync -a -e "$SSH" "$OVERLAY/tests/"       "$RIC:$RDESK/tests/"
echo "overlay staged"

# Restore the one grubbery file the overlay used to clobber. Must happen AFTER
# the rsync above, which no longer ships a competing obelisk-ast.hoon.
rsync -a -e "$SSH" "$PRISTINE_AST" "$RIC:$RDESK/gub/lib/obelisk-ast.hoon"
echo "grubbery obelisk-ast.hoon restored"

# obk-req is a POKE mark only — no grub is stored under it, so removing the marc
# is safe. obk-res IS a grub mark (the outgoing app wrote grubs under it); leaving
# its marc in place is what prevents %marc-not-found on those grubs.
$SSH "$RIC" "rm -f $RDESK/gub/mar/lattice/obk-req.hoon"
echo "orphaned obk-req.hoon marc removed (obk-res.hoon deliberately kept)"

say "verify before committing"
$SSH "$RIC" "
  md5sum $RDESK/gub/lib/obelisk-ast.hoon
  echo -n 'obelisk-ast lines: '; wc -l < $RDESK/gub/lib/obelisk-ast.hoon
  echo -n 'app.hoon lines:    '; wc -l < $RDESK/gub/nex/lattice/app.hoon
  echo -n 'obk marcs left:    '; ls $RDESK/gub/mar/lattice/ | grep obk | tr '\n' ' '; echo
"
echo
echo "EXPECT: md5 $AST_MD5, obelisk-ast 1208 lines, obk marcs = obk-res.hoon only."
echo "app.hoon lines must match this repo: $(wc -l < "$OVERLAY/nex/lattice/app.hoon")"

say "NOT COMMITTED — run this yourself in ricsul's dojo"
cat <<'EOF'
    |commit %grubbery

Watch for "did not compile" / dep failures. Then, in order:
  1. load the lattice UI          — a banged nexus persists across restart
  2. lattice-list via MCP         — the memory store must be intact
  3. GET  /catalog-init           — creates db + tables, idempotent
  4. GET  /catalog-scan-self      — proves the crawler path writes
  5. POST /know-reindex           — chunked, safe
  6. POST /search-reindex         — chunked, safe (was the wedge risk)
EOF
