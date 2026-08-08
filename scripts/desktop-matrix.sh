#!/usr/bin/env bash
# desktop-matrix.sh — drive the REAL desktop binary, headless, and check the
# things only it can do.
#
# WHY THIS EXISTS. Every desktop bug that reached a user did so through a path
# no test could touch:
#
#   - save_vault and pick_vault were missing from the command manifest, so
#     vault export and restore in the app failed on "not allowed. Command not
#     found" for weeks. The browser tests take the <a download> branch and
#     never invoke at all, so the one branch that only runs on desktop was the
#     one branch nothing ran.
#   - the File menu's buttons hid on a flag the binary injects. A browser can
#     only be told the flag is there; it cannot check that the app sets it.
#   - scheduled backups run Rust -> webview -> Rust -> disk. Every hop is
#     outside a browser.
#
# So: launch the actual binary under xvfb against a dev ship, inject a probe
# that reports what the page sees, and read the answers back out of the bridge
# log. Nothing here modifies the ship's files — the probe is injected by the
# app (LATTICE_PROBE_JS), so this can run against a ship it does not own.
#
# Usage:  scripts/desktop-matrix.sh [ship-url]
# Env:    LATTICE_URL     ship base (default http://localhost:8080)
#         LATTICE_COOKIE  cookie file (default ~/.config/lattice-fs/nec-cookie)
#         LATTICE_BIN     binary (default desktop/target/debug/lattice-desktop)
#
# NOT for production ships: it writes a backup archive and drives real saves.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
URL="${1:-${LATTICE_URL:-http://localhost:8080}}"
URL="${URL%/}"
COOKIE="${LATTICE_COOKIE:-$HOME/.config/lattice-fs/nec-cookie}"
BIN="${LATTICE_BIN:-$ROOT/desktop/target/debug/lattice-desktop}"
RUNFOR="${LATTICE_RUNFOR:-95}"

fails=0
ok()  { echo "  ok   - $1"; }
bad() { echo "  FAIL - $1${2:+ ($2)}"; fails=$((fails + 1)); }
chk() { if [ "$2" = "1" ]; then ok "$1"; else bad "$1" "${3:-}"; fi; }

case "$URL" in
  *urbit.sneagan.com*|*https://*)
    echo "refusing to run against $URL — this drives real writes, use a dev ship" >&2
    exit 2;;
esac
[ -x "$BIN" ] || { echo "no binary at $BIN (cargo build in desktop/)" >&2; exit 2; }
command -v xvfb-run >/dev/null || { echo "xvfb-run not found" >&2; exit 2; }
[ -r "$COOKIE" ] || { echo "no cookie at $COOKIE" >&2; exit 2; }

T="$(mktemp -d)"
BK="$T/archives"
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/home/.config/lattice-fs" "$T/home/.config/org.lattice.desktop" "$BK"
cp "$COOKIE" "$T/home/.config/lattice-fs/cookie"

# A schedule that is due immediately (last_run 0), so one tick backs up.
cat > "$T/home/.config/org.lattice.desktop/config.json" <<JSON
{"url":"$URL","mounts":[],"ship":"","queue_key":"",
 "backups":[{"id":"dm1","label":"matrix","every_hours":1,"keep":2,
             "dir":"$BK","last_run":0,"enabled":true}]}
JSON

# The probe reports by fetching a URL the bridge logs — the app has no other
# channel out, and this needs no devtools protocol the webview does not speak.
cat > "$T/probe.js" <<'JS'
(function () {
  if (!window.__TAURI__) return;
  var say = function (k, v) {
    try {
      fetch('/apps/lattice/page-tree?PROBE=' + encodeURIComponent(k + '=' + v));
    } catch (e) { /* nothing to report to */ }
  };
  var seen = false;
  var run = function () {
    // only the ship page has the tree; the manager page is not what we check
    if (seen || !document.getElementById('treelist')) return;
    seen = true;
    say('filemenuflag', window.__LATTICE_FILE_MENU__ ? 1 : 0);
    ['newfile', 'newfolder', 'newtmpl', 'upfiles', 'updir', 'save'].forEach(function (id) {
      var el = document.getElementById(id);
      say('hidden.' + id, (el && (el.hidden || el.offsetParent === null)) ? 1 : (el ? 0 : 'missing'));
    });
    // the capability regression that shipped broken for weeks. A DENIED
    // command answers at once with "not allowed"; a permitted one opens a
    // native dialog and never answers, so silence is the pass and we say so
    // explicitly rather than reading it as success by default.
    // `answered` is load-bearing. An unconditional timer here reported
    // "reached-dialog" even when the invoke had ALREADY come back denied, and
    // since the reader takes the last value it overwrote it — the harness
    // passed on the very bug it exists to catch, which a negative control
    // caught and nothing else would have.
    var answered = false;
    window.__TAURI__.core.invoke('save_vault', { name: 'probe.tar', b64: '' })
      .then(function () { answered = true; say('savevault', 'returned'); })
      .catch(function (e) {
        answered = true;
        say('savevault', String(e).indexOf('not allowed') >= 0 ? 'DENIED' : 'threw');
      });
    setTimeout(function () { if (!answered) say('savevault', 'reached-dialog'); }, 9000);
  };
  setTimeout(run, 14000);
  setTimeout(run, 22000);
})();
JS

echo "==> lattice desktop against $URL"
LOG="$T/app.log"
(
  export HOME="$T/home"
  export LATTICE_LOG=1
  export LATTICE_PROBE_JS="$T/probe.js"
  timeout "$RUNFOR" xvfb-run -a "$BIN" > "$LOG" 2>&1
)
echo "    ran for ${RUNFOR}s"

probe() {  # probe <key> -> value, or empty
  grep -o "PROBE=[^ ]*" "$LOG" 2>/dev/null | sed 's/^PROBE=//' \
    | python3 -c "import sys,urllib.parse
for l in sys.stdin:
    print(urllib.parse.unquote(l.strip()))" | grep "^$1=" | tail -1 | cut -d= -f2-
}

echo "==> the shell reaches the page"
booted=$(grep -c "bridge: GET /apps/lattice/app/app.js" "$LOG")
chk "the workspace loaded the ship's client through the bridge" \
  "$([ "$booted" -ge 1 ] && echo 1 || echo 0)" "no app.js request in the log"

echo "==> the File menu contract"
flag=$(probe filemenuflag)
chk "the build announces its File menu to the page" "$([ "$flag" = "1" ] && echo 1 || echo 0)" "flag=${flag:-<none>}"
for id in newfile newfolder newtmpl upfiles updir save; do
  h=$(probe "hidden.$id")
  chk "#$id is hidden, its command having moved to the menubar" \
    "$([ "$h" = "1" ] && echo 1 || echo 0)" "hidden=${h:-<none>}"
done

echo "==> the commands the page is allowed to call"
sv=$(probe savevault)
chk "save_vault reaches the app (vault export was DENIED for weeks)" \
  "$([ "$sv" = "reached-dialog" ] || [ "$sv" = "returned" ] && echo 1 || echo 0)" "savevault=${sv:-<none>}"

echo "==> a due schedule actually backs up"
wrote=$(grep -c "backup: wrote" "$LOG")
chk "the scheduler wrote an archive" "$([ "$wrote" -ge 1 ] && echo 1 || echo 0)" "no 'backup: wrote' in the log"
tar_file=$(ls "$BK"/lattice-matrix-*.tar 2>/dev/null | head -1)
chk "the archive is on disk under its schedule's name" \
  "$([ -n "$tar_file" ] && echo 1 || echo 0)" "nothing in $BK"
if [ -n "$tar_file" ]; then
  entries=$(tar -tf "$tar_file" 2>/dev/null | wc -l)
  chk "and it is a tar a real tar reads" "$([ "$entries" -gt 0 ] && echo 1 || echo 0)" "tar -tf found nothing"
  # a backup missing these restores as a store with no sharing and no memories,
  # which is the failure that looks like success
  for want in README.txt share.json know.json; do
    tar -tf "$tar_file" 2>/dev/null | grep -qx "$want" \
      && ok "the archive carries $want" \
      || bad "the archive carries $want" "absent"
  done
  tar -tf "$tar_file" 2>/dev/null | grep -q "^pages/" \
    && ok "the archive carries the pages" || bad "the archive carries the pages" "no pages/ entries"
  # last_run is stamped only after a successful write, or one bad evening
  # silently costs a whole period
  # the config is written pretty-printed, so there IS a space after the colon
  grep -Eq '"last_run": *[1-9]' "$T/home/.config/org.lattice.desktop/config.json" \
    && ok "the schedule recorded when it ran" \
    || bad "the schedule recorded when it ran" "last_run still 0"
fi

echo
if [ "$fails" -gt 0 ]; then echo "desktop-matrix FAILED ($fails)"; exit 1; fi
echo "desktop-matrix PASSED"
