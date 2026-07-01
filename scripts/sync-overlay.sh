#!/usr/bin/env bash
# Sync the lattice grubbery-overlay into a grubbery desk root.
#
# The lattice nexus must physically live in the %grubbery desk (grubbery's
# sync-gub only loads gub/ from its own desk). We keep the canonical source in
# THIS repo under grubbery-overlay/ and copy it into a grubbery desk tree.
#
# Layout mapping (overlay -> grubbery desk root):
#   lib/*.hoon          -> gub/lib/   (deployed: the nexus imports it here)
#                          lib/       (so desk-level /tests can import it too)
#   nex/lattice/*.hoon  -> gub/nex/lattice/
#   mar/lattice/*.hoon  -> gub/mar/lattice/
#   tests/**            -> tests/     (run via run-tests {desk:grubbery})
#
# Usage: scripts/sync-overlay.sh [grubbery-desk-root]
#   default target: the running ~zod pier's mounted grubbery desk.
# After syncing, commit the grubbery desk (mcp-zod commit-desk grubbery) and
# run-tests {desk:grubbery, path:/tests/lib/<name>}.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OVERLAY="$HERE/../grubbery-overlay"
DEST="${1:-/home/sneagan/software/zod/grubbery}"

if [ ! -d "$OVERLAY" ]; then echo "no overlay at $OVERLAY" >&2; exit 66; fi
if [ ! -d "$DEST" ]; then echo "no grubbery desk root at $DEST" >&2; exit 67; fi

mkdir -p "$DEST/gub/lib" "$DEST/lib" "$DEST/gub/nex/lattice" "$DEST/gub/mar/lattice" "$DEST/gub/mar/clay" "$DEST/tests/lib"

# Pure libs: into the tree (gub/lib, for the nexus) and the desk (lib, for tests).
rsync -a "$OVERLAY/lib/" "$DEST/gub/lib/"
rsync -a "$OVERLAY/lib/" "$DEST/lib/"
# Nexus + marks: into the gub tree only.
[ -d "$OVERLAY/nex/lattice" ] && rsync -a "$OVERLAY/nex/lattice/" "$DEST/gub/nex/lattice/"
[ -d "$OVERLAY/mar/lattice" ] && rsync -a "$OVERLAY/mar/lattice/" "$DEST/gub/mar/lattice/"
# Cross-desk poke marcs (e.g. obelisk-action): into grubbery's gub/mar/clay tree
# so handle-gall-poke can build the poke vase.
[ -d "$OVERLAY/mar-clay" ] && rsync -a "$OVERLAY/mar-clay/" "$DEST/gub/mar/clay/"
# Tests: desk-level.
rsync -a "$OVERLAY/tests/" "$DEST/tests/"

echo "synced overlay -> $DEST"
