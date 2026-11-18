#!/usr/bin/env bash
# Walks the screens sample pages can reach, writes each one's tree, and checks that every control has a name.
# Usage: scripts/a11y-walk.sh [out-dir]   (after cargo build)
set -u
out=${1:-/tmp/lattice-rune-a11y}; mkdir -p "$out"; rm -f "$out"/walk-*.json
bin=$(dirname "$0")/../target/debug/lattice-rune
walk() { # name, page to open, then events as JSON objects without their times
  local name=$1 page=$2; shift 2
  local ev='{"t": 0.5, "type": "tap", "key": "sample"}, {"t": 1.2, "type": "tap", "key": "'$page'"}' t=2
  for e in "$@"; do ev="$ev, {\"t\": $t, ${e#\{}"; t=$((t + 1)); done
  echo "{\"events\": [$ev]}" > "$out/walk.script"
  env -u LATTICE_URL -u LATTICE_COOKIE XDG_CONFIG_HOME="$out/cfg" timeout 90 "$bin" --theme dark --scale 1 --size 1100x1600 --script "$out/walk.script" --tree "$out/walk-$name.json" --at $((t + 1)) 2>&1 | grep -v '^rune:' | sed "s/^/$name: /"
}
tap() { echo "{\"type\": \"tap\", \"key\": \"$1\"}"; }
key() { echo "{\"type\": \"key\", \"name\": \"$1\", \"cmd\": true}"; }
walk read welcome
walk settings welcome "$(tap settings-open)"
walk settings-scoped welcome "$(tap settings-open)" "$(tap kpages-some)" "$(tap kweb-some)"
walk access welcome "$(tap access-open)"
walk inbox welcome "$(tap inbox-open)"
walk shared welcome "$(tap shared-open)"
walk share welcome "$(tap share)"
walk links welcome "$(tap links-toggle)"
walk comments welcome "$(tap comments-toggle-pane)"
walk history welcome "$(tap history-toggle)"
walk edit-rich welcome "$(tap edit)"
walk edit-source welcome "$(tap edit)" "$(tap mode)"
walk search-pane welcome "$(tap half-search)" '{"type": "type", "text": "rune"}'
walk find welcome "$(key f)"
walk palette welcome "$(key p)"
walk jump welcome "$(key o)"
walk new welcome "$(tap new)"
walk rename welcome "$(tap rename)"
walk delete welcome "$(tap delete)"
walk split welcome "$(tap split)" "$(tap budget)"
walk tabs welcome "$(key t)" "$(tap budget)"
walk memory welcome "$(tap half-memory)"
walk memory-open welcome "$(tap half-memory)" "$(tap feedback/short-answers)"
walk capture welcome "$(tap capture)"
walk sheet budget
walk map places
walk map-region region
walk folder welcome "$(tap notes)"
# with A11Y_SHIP=1 and LATTICE_URL and LATTICE_COOKIE set, the screens only a ship has are walked too.
# The ship needs a private board `modt` with a thread on it (scripts/forum-seed.sh makes boards) and a folder `udir`.
if [ -n "${A11Y_SHIP:-}" ]; then
  ship() { local name=$1; shift; local ev='' t=2
    for e in "$@"; do ev="$ev${ev:+, }{\"t\": $t, ${e#\{}"; t=$((t + 3)); done
    echo "{\"events\": [$ev]}" > "$out/walk.script"
    XDG_CONFIG_HOME="$out/cfg-ship" timeout 120 "$bin" --theme dark --scale 1 --size 1100x1800 --script "$out/walk.script" --tree "$out/walk-ship-$name.json" --at $((t + 3)) 2>&1 | grep -v '^rune:' | sed "s/^/ship-$name: /"; }
  ship boards "$(tap forum-open)"
  ship board-new "$(tap forum-open)" "$(tap board-new)"
  ship notes "$(tap forum-open)" "$(tap notes-open)"
  ship board "$(tap forum-open)" "$(tap board-modt)"
  ship board-edit "$(tap forum-open)" "$(tap board-modt)" "$(tap board-edit)"
  ship board-mod "$(tap forum-open)" "$(tap board-modt)" "$(tap board-mod)"
  ship thread-new "$(tap forum-open)" "$(tap board-modt)" "$(tap forum-new)"
  ship thread "$(tap forum-open)" "$(tap board-modt)" "$(tap post-1)"
  ship settings "$(tap settings-open)"
  ship address "$(tap shared-open)" "$(tap urb-address)" '{"type": "type", "text": "~zod/udir/"}' '{"type": "key", "name": "Enter"}'
fi
python3 "$(dirname "$0")/a11y.py" "$out"/walk-*.json
