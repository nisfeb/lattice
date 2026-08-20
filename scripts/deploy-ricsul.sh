#!/usr/bin/env bash
# Deploy the lattice overlay to ~ricsul-bilwyt.
#
# Ricsul is production. This script stages every file and then STOPS, printing
# the |commit for a human to run in the ship's dojo. Staging is inert on its
# own: grubbery loads nothing until the desk is committed, so the whole overlay
# lands in one atomic step and a half-finished transfer is recoverable by
# re-running rather than by repairing a live ship.
#
# Usage: scripts/deploy-ricsul.sh [--go]
#   no flag  dry run: report what would change, touch nothing
#   --go     stage the files on ricsul, verify, then STOP and print the |commit
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
OVERLAY="$REPO/grubbery-overlay"

RIC="sneagan@45.33.75.69"
#  One connection, reused. The staging step fires six rsyncs back to back and
#  the host resets the later ones ("Connection closed by ..."), which failed
#  the deploy halfway through. Multiplexing opens a single session and keeps it
#  briefly, so the transfers queue on it instead of racing the SSH throttle.
SSHCTL="/tmp/lattice-ric-%r@%h:%p"
SSH="ssh -p 4141 -o ControlMaster=auto -o ControlPath=$SSHCTL -o ControlPersist=180"
RDESK="/home/sneagan/ricsul-bilwyt/_data/ricsul-bilwyt/grubbery"

GO=0
[ "${1:-}" = "--go" ] && GO=1

say() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

say "preflight"
[ -d "$OVERLAY" ] || { echo "no overlay at $OVERLAY" >&2; exit 66; }

# The repo must be clean and pushed. Ricsul is deployed from these files, and a
# dirty tree makes "what is on the ship" unanswerable later.
cd "$REPO"
[ -z "$(git status --porcelain)" ] || { echo "repo is dirty — commit first" >&2; exit 69; }
echo "repo clean at $(git rev-parse --short HEAD)"

# Ricsul runs MAIN. A feature branch can lag main (one deployed tonight was
# missing a merged feature and silently clobbered it on the ship).
git fetch origin --quiet
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  echo "HEAD is not origin/main — deploy from latest main (or edit this check if you mean it)" >&2
  exit 70
fi

say "current state on ricsul"
$SSH "$RIC" "
  echo -n 'gub/nex/lattice/app.hoon: '; wc -l < $RDESK/gub/nex/lattice/app.hoon
  echo -n 'lattice libs:             '; ls $RDESK/gub/lib/ | grep -c '^lattice'
  echo -n 'lattice marcs:            '; ls $RDESK/gub/mar/lattice/ | wc -l
"

if [ "$GO" -eq 0 ]; then
  say "DRY RUN — nothing was changed"
  echo "re-run with --go to stage the deploy."
  exit 0
fi

say "staging (same six mappings as sync-overlay.sh; never add --delete)"
rsync -a -e "$SSH" "$OVERLAY/lib/"         "$RIC:$RDESK/gub/lib/"
rsync -a -e "$SSH" "$OVERLAY/lib/"         "$RIC:$RDESK/lib/"
rsync -a -e "$SSH" --exclude 'ui-app/src' "$OVERLAY/nex/lattice/" "$RIC:$RDESK/gub/nex/lattice/"
rsync -a -e "$SSH" "$OVERLAY/mar/lattice/" "$RIC:$RDESK/gub/mar/lattice/"
[ -d "$OVERLAY/mar-clay" ] && rsync -a -e "$SSH" "$OVERLAY/mar-clay/" "$RIC:$RDESK/gub/mar/clay/"
rsync -a -e "$SSH" "$OVERLAY/tests/"       "$RIC:$RDESK/tests/"
echo "overlay staged"

say "verify before committing"
$SSH "$RIC" "
  echo -n 'app.hoon lines:  '; wc -l < $RDESK/gub/nex/lattice/app.hoon
  echo -n 'lattice libs:    '; ls $RDESK/gub/lib/ | grep -c '^lattice'
  echo -n 'lattice marcs:   '; ls $RDESK/gub/mar/lattice/ | wc -l
"
echo
echo "EXPECT: app.hoon $(wc -l < "$OVERLAY/nex/lattice/app.hoon") lines (exact), at least"
echo "$(ls "$OVERLAY/lib" | grep -c '^lattice') lattice libs and $(ls "$OVERLAY/mar/lattice" | wc -l) lattice marcs."
echo "The staging rsyncs never delete, so the ship may carry more than the repo."
echo "Fewer, or a wrong app.hoon length, means the transfer did not land. Do NOT commit."

say "NOT COMMITTED — run this yourself in ricsul's dojo"
cat <<'EOF'
    |commit %grubbery

Watch for "did not compile" / dep failures. Then, in order:
  1. load the lattice UI      - a banged nexus persists across restart
  2. lattice-list via MCP     - the memory store must be intact
  3. POST /search-reindex     - rebuilds the term index, one dart
  4. GET /content-search?term=<a word you know is there>
EOF
