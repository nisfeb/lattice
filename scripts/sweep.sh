#!/usr/bin/env bash
# sweep.sh: kill what earlier lattice test runs left behind.
#
#   scripts/sweep.sh        kill the orphans
#   scripts/sweep.sh -n     list them, kill nothing
#
# A process is ours only if it carries our marker: gate.mjs, lib/harness.mjs
# and lib/hygiene.sh put LATTICE_TEST_OWNER=<pid>:<starttime> in the
# environment of everything they start, and browsers, Xvfb, WebKitWebDriver
# and relays inherit it. It is an orphan when that owner is gone (the pid is
# dead, or now belongs to a process with another start time). A run still
# going is left alone, and so is everything without the marker: other
# sessions' browsers, relays, Xvfb displays and ships are never signalled.
# Fleet's ships and tmux are skipped even if marked: they outlive runs on
# purpose, and fleet drop / fleet down stop them.
set -uo pipefail
DRY=0
case "${1:-}" in
  -n|--dry-run) DRY=1 ;;
  '') ;;
  *) echo "usage: sweep.sh [-n]" >&2; exit 2 ;;
esac

starttime() { local s; s=$({ cat "/proc/$1/stat"; } 2>/dev/null) || return 1; s=${s##*) }; set -- $s; echo "${20}"; }
alive() { local pid=${1%%:*} st=${1#*:} now; now=$(starttime "$pid" 2>/dev/null) && [ "$now" = "$st" ]; }

me=$$
orphans=()
for d in /proc/[0-9]*; do
  p=${d#/proc/}
  [ "$p" = "$me" ] && continue
  [ -O "$d" ] || continue                      # our user's processes only
  owner=$({ tr '\0' '\n' < "$d/environ"; } 2>/dev/null | sed -n 's/^LATTICE_TEST_OWNER=//p' | head -1)
  [ -n "$owner" ] || continue
  alive "$owner" && continue
  comm=$({ cat "$d/comm"; } 2>/dev/null) || continue
  case "$comm" in tmux*|urbit*|vere*) continue ;; esac
  orphans+=("$p")
  printf '%s %s (owner %s gone): %s\n' "$p" "$comm" "$owner" \
    "$({ tr '\0' ' ' < "$d/cmdline"; } 2>/dev/null | cut -c1-160)"
done

if [ ${#orphans[@]} -eq 0 ]; then echo "sweep: no orphans"; exit 0; fi
if [ "$DRY" = 1 ]; then echo "sweep: ${#orphans[@]} orphans (dry run, nothing killed)"; exit 0; fi
kill -TERM "${orphans[@]}" 2>/dev/null
for _ in 1 2 3 4 5; do
  left=(); for p in "${orphans[@]}"; do kill -0 "$p" 2>/dev/null && left+=("$p"); done
  [ ${#left[@]} -eq 0 ] && break; sleep 1
done
[ ${#left[@]} -gt 0 ] && kill -KILL "${left[@]}" 2>/dev/null
echo "sweep: killed ${#orphans[@]} orphans"
