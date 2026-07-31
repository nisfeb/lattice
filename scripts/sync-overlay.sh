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
# DEST is REQUIRED. The old default pointed at ~zod — a scratch ship that gets
# rebuilt and renamed; an implicit deploy target is how code lands on the wrong
# pier. Say where it goes.
DEST="${1:?usage: sync-overlay.sh <grubbery-desk-root>}"

if [ ! -d "$OVERLAY" ]; then echo "no overlay at $OVERLAY" >&2; exit 66; fi
if [ ! -d "$DEST" ]; then echo "no grubbery desk root at $DEST" >&2; exit 67; fi

mkdir -p "$DEST/gub/lib" "$DEST/lib" "$DEST/gub/nex/lattice" "$DEST/gub/mar/lattice" "$DEST/gub/mar/clay" "$DEST/tests/lib"

# SHADOW CHECK. gub/lib is SHARED with grubbery's own libraries, and rsync has no
# --delete, so an overlay file silently overwrites a grubbery file of the same
# name and no later sync ever puts it back. This is not hypothetical: a 28-line
# lib/obelisk-ast.hoon here clobbered grubbery's real 1208-line one on every sync
# and broke grubbery's whole obelisk integration on every ship it touched. Nothing
# reported it, because the overwritten file compiles fine on its own.
#
# The overlay owns lattice-*.hoon, catalog*.hoon and everything under nex/lattice.
# Anything else landing on top of an EXISTING destination file is a collision and
# must be deliberate, so refuse and make the human look.
SHADOW=0
for f in "$OVERLAY"/lib/*.hoon; do
  [ -e "$f" ] || continue
  b="$(basename "$f")"
  case "$b" in lattice-*|catalog*) continue ;; esac
  if [ -e "$DEST/gub/lib/$b" ] && ! cmp -s "$f" "$DEST/gub/lib/$b"; then
    echo "REFUSING: overlay lib/$b would overwrite a different gub/lib/$b" >&2
    echo "  If that file belongs to grubbery, the overlay must not ship it." >&2
    SHADOW=1
  fi
done
[ "$SHADOW" -eq 0 ] || exit 69

# Pure libs: into the tree (gub/lib, for the nexus) and the desk (lib, for tests).
rsync -a "$OVERLAY/lib/" "$DEST/gub/lib/"
rsync -a "$OVERLAY/lib/" "$DEST/lib/"
# Nexus + marks: into the gub tree only. ui-app/src is build SOURCE — only the
# built app.js ships; the desk must not carry files the ball never loads.
[ -d "$OVERLAY/nex/lattice" ] && rsync -a --exclude 'ui-app/src' "$OVERLAY/nex/lattice/" "$DEST/gub/nex/lattice/"
[ -d "$OVERLAY/mar/lattice" ] && rsync -a "$OVERLAY/mar/lattice/" "$DEST/gub/mar/lattice/"
# Cross-desk poke marcs (e.g. obelisk-action): into grubbery's gub/mar/clay tree
# so handle-gall-poke can build the poke vase.
[ -d "$OVERLAY/mar-clay" ] && rsync -a "$OVERLAY/mar-clay/" "$DEST/gub/mar/clay/"
# Tests: desk-level.
rsync -a "$OVERLAY/tests/" "$DEST/tests/"

# Print what actually landed — a grubbery core update wipes none of its own
# apps but knows nothing about this overlay, so any grubbery re-sync MUST be
# followed by this script before committing the desk. Zero counts here mean
# the next |commit will cull lattice from clay and take the app down.
NEX=$(find "$DEST/gub/nex/lattice" -type f | wc -l)
LIB=$(ls "$DEST/gub/lib" | grep -c '^lattice' || true)
echo "synced overlay -> $DEST (nex/lattice: $NEX files, lattice libs: $LIB)"
if [ "$NEX" -eq 0 ] || [ "$LIB" -eq 0 ]; then
  echo "WARNING: overlay did not land — do NOT commit the desk" >&2
  exit 68
fi
