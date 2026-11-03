#!/usr/bin/env bash
# fs-old-beacon-check.sh: a lattice-fs mount still sees ship-side changes
# minutes after it mounts.
#
# lattice-fs builds before 2026-11 (the desktop app's among them) watch the
# keep at /grubbery/api/keep/apps/lattice.lattice_app/beacon/rev. On a desk
# install nothing was there: the keep opened about 30 s in and then sent only
# heartbeats, the mount took that as a live stream and stopped polling, and
# no change made on the ship reached it again until a remount. The ship now
# writes that beacon too (+old-beacon-arm in app.hoon). Run this with an OLD
# binary to check the ship side, and with a new one to check it still works.
#
# The mount settles past the heartbeat with a listing of its own, then at
# 60 s and at 180 s after mounting the ship saves a page over HTTP, and the
# mount must show each one within 15 s. On origin/main 8f3cbd1, ship and
# binary both, both checks fail.
#
# Usage:  scripts/fs-old-beacon-check.sh [ship-url]
#   env:  LATTICE_URL and LATTICE_COOKIE (required, a throwaway ship)
#         BIN  the lattice-fs to mount with (default this checkout's build)
#         LATTICE_COOKIE  the session cookie file, as for fs-matrix.sh
#           (default ~/.config/lattice-fs/cookie). The mount is handed a
#           copy in a HOME of its own, so it never reads or writes yours.
#
# Takes a little over three minutes. Test pages live under fsoldb/ and are
# deleted on exit.

set -u
LATTICE_URL="${1:-${LATTICE_URL:-}}"
. "$(dirname "${BASH_SOURCE[0]}")/lib/matrix.sh"
need_cookie
BIN="${BIN:-$(cd "$(dirname "$0")/.." && pwd)/lattice-fs-rs/target/release/lattice-fs}"
WORK="$(mktemp -d)"
MNT="$WORK/lat"
PID=
# the binary reads the cookie for this origin only, from
# $HOME/.config/lattice-fs/cookie-<scheme>-<host>-<port>
hp="${URL#*://}"; hp="${hp%%/*}"; sch="${URL%%://*}"
case "$hp" in *:*) port="${hp##*:}"; host="${hp%:*}" ;; *) host="$hp"; port=$([ "$sch" = https ] && echo 443 || echo 80) ;; esac
mkdir -p "$WORK/home/.config/lattice-fs"
( umask 077; cp "$CKF" "$WORK/home/.config/lattice-fs/cookie-$sch-$host-$port" )

save() { curl -s -o /dev/null -X POST -H "$CK" -H 'Content-Type: text/plain' \
  --data "$2" "$URL/apps/lattice/page-save?name=$1&type=md"; }
cleanup() {
  cd /
  fusermount -u "$MNT" 2>/dev/null; sleep 0.3
  [ -n "$PID" ] && { kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null; }
  mountpoint -q "$MNT" && fusermount -uz "$MNT" 2>/dev/null
  curl -s -o /dev/null -X POST -H "$CK" "$URL/apps/lattice/page-del?name=fsoldb"
  # never rm through a live mount: that would delete the ship's pages
  if mountpoint -q "$MNT"; then echo "left $WORK: $MNT is still mounted" >&2
  else rm -rf --one-file-system "$WORK"; fi
}
trap cleanup EXIT

[ -x "$BIN" ] || { echo "no lattice-fs at $BIN (set BIN)"; exit 2; }
curl -s -o /dev/null --max-time 3 "$URL/" || { echo "ship unreachable at $URL"; exit 2; }

curl -s -o /dev/null -X POST -H "$CK" "$URL/apps/lattice/page-del?name=fsoldb"
save fsoldb/start 'here before the mount'
mkdir -p "$MNT"
unset LATTICE_SOCK
HOME="$WORK/home" LATTICE_URL="$URL" "$BIN" mount "$MNT" >/dev/null 2>"$WORK/mount.log" &
PID=$!
T0=$(date +%s)
exec </dev/null
at() { while [ $(( $(date +%s) - T0 )) -lt "$1" ]; do sleep 1; done; }
seen() { # seen <page>: whether the mount shows fsoldb/<page>.md within 15 s
  for _ in $(seq 1 15); do [ -e "$MNT/fsoldb/$1.md" ] && { echo y; return; }; sleep 1; done
  echo n; }

echo "mounting $BIN on $URL"
at 3
is "the mount shows what was there before it" 'y' "$(seen start)"
[ "$fails" = 0 ] || { echo "the mount did not come up:"; head -5 "$WORK/mount.log"; finish; }
# past the keep's 30 s heartbeat, and the one refresh an open stream
# leaves pending, so the checks below see only what the watch delivers
at 40
ls -R "$MNT/fsoldb" >/dev/null; sleep 3; ls -R "$MNT/fsoldb" >/dev/null
at 60
save fsoldb/at60 'saved on the ship 60 s in'
is "a page saved on the ship 60 s after mounting shows" 'y' "$(seen at60)"
at 180
save fsoldb/at180 'saved on the ship 180 s in'
is "a page saved on the ship 180 s after mounting shows" 'y' "$(seen at180)"
finish
