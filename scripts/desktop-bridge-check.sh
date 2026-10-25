#!/usr/bin/env bash
# desktop-bridge-check.sh: does the REAL webview carry the bridge token?
#
# The bridge signs a request with the owner's session only when it carries
# this launch's token, which the workspace holds as a first-party HttpOnly
# cookie (desktop/src/proxy.rs). Unit tests prove the bridge's rule. Only
# the real WebKit can show the cookie actually rides on everything the
# client sends: page fetches, SSE, images, and fetches a service worker
# makes. And that it does NOT ride on a sandboxed frame's requests, or on a
# request from another local process.
#
# Needs no ship: the "ship" is scripts/lib/bridge-stub.py on loopback.
# Usage:  scripts/desktop-bridge-check.sh
# Env:    LATTICE_BIN  binary (default desktop/target/debug/lattice-desktop)
#         STUB_PORT    stub ship port (default 18765)
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$ROOT/scripts/lib/matrix.sh"
BIN="${LATTICE_BIN:-$ROOT/desktop/target/debug/lattice-desktop}"
PORT="${STUB_PORT:-18765}"
[ -x "$BIN" ] || { echo "no binary at $BIN (cargo build in desktop/)" >&2; exit 2; }
command -v xvfb-run >/dev/null || { echo "xvfb-run not found" >&2; exit 2; }

T="$(mktemp -d)"
trap 'kill "$STUB" 2>/dev/null; rm -rf "$T"' EXIT
python3 -I "$ROOT/scripts/lib/bridge-stub.py" "$PORT" "$T/stub.log" &
STUB=$!
sleep 1
# the desktop keeps one session per ship origin (session.rs)
mkdir -p "$T/home/.config/lattice-fs/desktop" "$T/home/.config/org.lattice.desktop"
printf 'urbauth-~zod=test' > "$T/home/.config/lattice-fs/desktop/cookie-http_3a_2f_2f127.0.0.1_3a$PORT"
printf '{"url":"http://127.0.0.1:%s","mounts":[],"ship":"","queue_key":"","backups":[]}' "$PORT" \
  > "$T/home/.config/org.lattice.desktop/config.json"

echo "==> lattice desktop against a stub ship on 127.0.0.1:$PORT"
# the XDG dirs too: CI runners set XDG_CONFIG_HOME, which outranks HOME
( export HOME="$T/home" XDG_CONFIG_HOME="$T/home/.config" XDG_DATA_HOME="$T/home/.local/share" \
    XDG_CACHE_HOME="$T/home/.cache" LATTICE_LOG=1
  timeout 60 xvfb-run -a "$BIN" > "$T/app.log" 2>&1 ) &
APP=$!
# the port comes from THIS app's log: on a machine running the real app, the
# canonical port belongs to it and relays to a real ship. Poll for it: a slow
# CI runner can take more than 30 s to log it, and a fixed sleep then sent no
# request at all, so the last check read "absent" instead of "no".
bport=
for _ in $(seq 50); do
  bport=$(grep -o "bridge: listening on 127.0.0.1:[0-9]*" "$T/app.log" | head -1 | sed 's/.*://')
  [ -n "$bport" ] && break
  sleep 1
done
[ -n "$bport" ] && curl -s -o /dev/null "http://127.0.0.1:$bport/apps/lattice/owner?via=other-local-process"
wait "$APP"
[ -s "$T/stub.log" ] || { echo "the stub saw no request. The app said:"; tail -40 "$T/app.log"; }

# session <via> -> yes, no, mixed or absent
session() {
  python3 -I -c 'import json, sys
s = {json.loads(l)["session"] for l in open(sys.argv[1]) if ("via=" + sys.argv[2]) in json.loads(l)["path"]}
print({frozenset({True}): "yes", frozenset({False}): "no"}.get(frozenset(s), "mixed" if s else "absent"))' "$T/stub.log" "$1"
}
is "the workspace page's own fetch carries the session" yes "$(session page)"
is "the SSE stream carries the session" yes "$(session sse)"
is "an image (through the service worker) carries the session" yes "$(session sw-img)"
is "a fetch made by the service worker carries the session" yes "$(session sw-page)"
is "a sandboxed frame's image does not" no "$(session sandboxed-img)"
is "another local process does not" no "$(session other-local-process)"
finish
