#!/usr/bin/env bash
# clean-targets.sh: free the Rust target/ dirs of worktrees that are done.
#
#   scripts/clean-targets.sh          list what would go, and its size
#   scripts/clean-targets.sh --yes    delete it
#
# A worktree is done when its HEAD is merged into origin/main (an ancestor
# of it; fetch first for a fresh answer). Only its cargo target dirs go
# (a dir named target holding CACHEDIR.TAG or .rustc_info.json, the marks
# cargo leaves): the worktree, its branch and its changes stay. The main
# worktree is never touched. Each target is rebuilt by the next cargo build.
set -uo pipefail
YES=0
case "${1:-}" in --yes) YES=1 ;; '') ;; *) echo "usage: clean-targets.sh [--yes]" >&2; exit 2 ;; esac
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 2
git rev-parse -q --verify origin/main >/dev/null || { echo "no origin/main here" >&2; exit 2; }

main_wt=$(git worktree list --porcelain | sed -n '1s/^worktree //p')
total=0
while read -r wt; do
  [ "$wt" = "$main_wt" ] && continue
  [ -d "$wt" ] || continue
  head=$(git -C "$wt" rev-parse -q --verify HEAD) || continue
  git merge-base --is-ancestor "$head" origin/main || continue
  while IFS= read -r t; do
    [ -e "$t/CACHEDIR.TAG" ] || [ -e "$t/.rustc_info.json" ] || continue
    kb=$(du -sk "$t" 2>/dev/null | cut -f1); total=$((total + kb))
    printf '%8s MB  %s (%s)\n' "$((kb / 1024))" "$t" "$(git -C "$wt" rev-parse --abbrev-ref HEAD)"
    [ "$YES" = 1 ] && rm -rf -- "$t"
  done < <(find "$wt" -maxdepth 4 -type d -name target -not -path '*/node_modules/*' -prune 2>/dev/null)
done < <(git worktree list --porcelain | sed -n 's/^worktree //p')

if [ "$YES" = 1 ]; then echo "clean-targets: freed $((total / 1024)) MB"
else echo "clean-targets: $((total / 1024)) MB in merged worktrees; --yes deletes it"; fi
