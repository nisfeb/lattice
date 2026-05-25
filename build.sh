#!/usr/bin/env bash
#
# Assemble the complete, installable %lattice desk under dist/.
#
# The repo's desk/ holds only lattice's own source; the standard base-dev libs
# and marks a Gall desk needs are vendored in by `peru sync` (pinned in
# peru.yaml). With -p, the assembled desk is also copied into a mounted Clay
# desk on a running ship, ready to |commit and |install.
#
# Usage:
#   ./build.sh                       build dist/
#   ./build.sh -p ~/zod/lattice      build, then copy into a mounted desk
#   ./build.sh clean                 remove dist/
#   ./build.sh help
#
# Install flow (see README "Install"):
#   dojo>  |new-desk %lattice
#   dojo>  |mount %lattice
#   bash>  ./build.sh -p ~/path/to/zod/lattice
#   dojo>  |commit %lattice
#   dojo>  |install our %lattice
#
# Requires peru (https://github.com/buildinspace/peru) on PATH.

set -euo pipefail

COPY_PATH=""
COMMAND=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -p)
      if [[ -z "${2:-}" ]]; then
        echo "Error: -p requires a filepath argument" >&2
        exit 1
      fi
      COPY_PATH="$2"
      shift 2
      ;;
    *)
      if [[ -n "$COMMAND" ]]; then
        echo "Error: only one command is allowed" >&2
        exit 1
      fi
      COMMAND="$1"
      shift
      ;;
  esac
done

COMMAND="${COMMAND:-build}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

check_peru() {
  if ! command -v peru &>/dev/null; then
    echo "Error: peru is not installed or not on PATH." >&2
    echo "See: https://github.com/buildinspace/peru" >&2
    exit 1
  fi
}

copy_to_path() {
  local target="$1"
  if [[ ! -d dist ]]; then
    echo "Error: dist/ not found — run build first." >&2
    exit 1
  fi
  if [[ ! -d "$target" ]]; then
    echo "Error: target desk path '$target' does not exist (|mount it first)." >&2
    exit 1
  fi
  # Refresh the desk source but PRESERVE /pub — that's the ship's published
  # gemtext content, which must survive an agent update/re-install.
  echo "Refreshing desk at $target (preserving /pub) ..."
  find "${target:?}" -mindepth 1 -maxdepth 1 ! -name pub -exec rm -rf {} +
  cp -r dist/. "$target"/
  echo "Copied. Now in dojo:  |commit %<desk>  then  |install our %<desk>"
}

build() {
  check_peru
  if [[ ! -d desk ]]; then
    echo "Error: desk/ directory not found." >&2
    exit 1
  fi

  echo "Resetting dist/ ..."
  rm -rf dist
  mkdir -p dist

  echo "Copying desk/ → dist/ ..."
  cp -r desk/. dist/
  # Drop repo housekeeping that shouldn't ship in the desk.
  find dist -name '.keep' -delete
  rm -f dist/README.md

  echo "Vendoring kernel deps (peru sync) ..."
  if ! peru sync 2>&1; then
    echo "Error: peru sync failed — cleaning up dist/." >&2
    rm -rf dist
    exit 1
  fi

  echo "Build complete: dist/"
  if [[ -n "$COPY_PATH" ]]; then
    copy_to_path "$COPY_PATH"
  fi
}

clean() {
  rm -rf dist
  echo "Removed dist/"
}

case "$COMMAND" in
  build) build ;;
  clean) clean ;;
  help)
    sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    ;;
  *)
    echo "Error: unknown command '$COMMAND' (try: build, clean, help)" >&2
    exit 1
    ;;
esac
