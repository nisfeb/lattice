#!/usr/bin/env bash
# clean-targets.sh: free the Rust target/ dirs of worktrees that are done.
#
#   scripts/clean-targets.sh          list what would go, and its size
#   scripts/clean-targets.sh --yes    delete it
#
# A worktree is done when all of these hold (fetch first for a fresh
# answer):
#   - its HEAD is a commit of its own branch merged into origin/main: an
#     ancestor of origin/main that is not on main's first-parent line. A
#     fresh worktree with no commits sits on main's line, and is in use.
#   - no target dir of it was touched in the last 2 hours
#     (CLEAN_TARGETS_IDLE_MIN, in minutes)
#   - no process has its cwd inside it (/proc/*/cwd)
# Only its cargo target dirs go
# (a dir named target holding CACHEDIR.TAG or .rustc_info.json, the marks
# cargo leaves): the worktree, its branch and its changes stay. The main
# worktree is never touched. Each target is rebuilt by the next cargo build.
set -uo pipefail
YES=0
case "${1:-}" in --yes) YES=1 ;; '') ;; *) echo "usage: clean-targets.sh [--yes]" >&2; exit 2 ;; esac
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 2
git rev-parse -q --verify origin/main >/dev/null || { echo "no origin/main here" >&2; exit 2; }

main_wt=$(git worktree list --porcelain | sed -n '1s/^worktree //p')
idle=${CLEAN_TARGETS_IDLE_MIN:-120}
# main's own commits: a HEAD among them was branched and never committed to
mainline=$(git rev-list --first-parent origin/main)
# every process cwd we can read, to keep the worktrees still in use
cwds=$(for c in /proc/[0-9]*/cwd; do readlink "$c" 2>/dev/null; done)
in_use() {
  local d
  while IFS= read -r d; do
    case "$d" in "$1"|"$1"/*) return 0 ;; esac
  done <<<"$cwds"
  return 1
}
skip() { echo "    keep  $1 ($2)"; }
total=0
while read -r wt; do
  [ "$wt" = "$main_wt" ] && continue
  [ -d "$wt" ] || continue
  head=$(git -C "$wt" rev-parse -q --verify HEAD) || continue
  git merge-base --is-ancestor "$head" origin/main || continue
  grep -qx "$head" <<<"$mainline" && { skip "$wt" "no commits of its own"; continue; }
  in_use "$wt" && { skip "$wt" "a process works in it"; continue; }
  targets=()
  while IFS= read -r t; do
    [ -e "$t/CACHEDIR.TAG" ] || [ -e "$t/.rustc_info.json" ] || continue
    targets+=("$t")
  done < <(find "$wt" -maxdepth 4 -type d -name target -not -path '*/node_modules/*' -prune 2>/dev/null)
  busy=
  for t in "${targets[@]}"; do
    [ -n "$(find "$t" -mmin "-$idle" -print -quit 2>/dev/null)" ] && busy=$t
  done
  [ -n "$busy" ] && { skip "$wt" "$busy touched in the last $idle min"; continue; }
  for t in "${targets[@]}"; do
    kb=$(du -sk "$t" 2>/dev/null | cut -f1); total=$((total + kb))
    printf '%8s MB  %s (%s)\n' "$((kb / 1024))" "$t" "$(git -C "$wt" rev-parse --abbrev-ref HEAD)"
    [ "$YES" = 1 ] && rm -rf -- "$t"
  done
done < <(git worktree list --porcelain | sed -n 's/^worktree //p')

if [ "$YES" = 1 ]; then echo "clean-targets: freed $((total / 1024)) MB"
else echo "clean-targets: $((total / 1024)) MB in merged worktrees; --yes deletes it"; fi
