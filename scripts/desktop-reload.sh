#!/usr/bin/env bash
# desktop-reload.sh: the shipless reader's reload, end to end, in the REAL
# binary.
#
# Publishes a page on a fleet ship and reads it in the reader, then edits
# it while the page is open. A plain visit inside the engine's 60 s still
# shows the old text (the kept revision list), and each kind of reload
# must show the newest within a few seconds: Ctrl+R (reader.js, as the
# reload button), Enter on the address already shown, and the webview's
# own reload (location.reload, as its menu or a key it keeps would). Back
# afterwards is no reload.
#
# The engine reads a fleet ship as a fake moon (LATTICE_ENGINE_FAKE, debug
# builds only): the fake network has no comets. Fake fleet ships only.
#
# Usage:  FLEET_WHO=<you> scripts/desktop-reload.sh
# Env:    LATTICE_BIN  binary (default desktop/target/debug/lattice-desktop)
#         FLEET        the fleet script; KEEP=1 leaves the set claimed
#         FLEET_SET, FLEET_SNAP, PUB, PIER, SHIP_URL  the publisher (default
#                      lattice-gate-peer reset to lattice: ~wep on 8151)
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MATRIX_NO_SHIP=1 . "$ROOT/scripts/lib/matrix.sh"
: "${FLEET_WHO:?set FLEET_WHO to who is claiming the set}"
BIN="${LATTICE_BIN:-$ROOT/desktop/target/debug/lattice-desktop}"
FLEET=${FLEET:-$HOME/software/personal/hoon-development/fleet/fleet}
SET=${FLEET_SET:-lattice-gate-peer}
SNAP=${FLEET_SNAP:-lattice}
PUB=${PUB:-~wep}
PIER=${PIER:-$HOME/fleet/piers/${PUB#\~}}
SHIP_URL=${SHIP_URL:-http://localhost:8151}
[ -x "$BIN" ] || { echo "no binary at $BIN (cargo build in desktop/)" >&2; exit 2; }
command -v Xvfb >/dev/null || { echo "Xvfb not found" >&2; exit 2; }

holder=$("$FLEET" ls 2>/dev/null | awk -v s="$SET" '$1==s' | grep -oE '\([^)]*\)' | tr -d '()' || true)
if [ -n "$holder" ] && [ "$holder" != "$FLEET_WHO" ]; then
  echo "skipped: $SET is claimed by $holder"
  exit 0
fi
T="$(mktemp -d)"
cleanup() {
  [ -n "${XVFB:-}" ] && kill "$XVFB" 2>/dev/null
  [ -n "${APP:-}" ] && kill "$APP" 2>/dev/null
  rm -rf "$T"
  if [ "${KEEP:-}" != 1 ]; then
    "$FLEET" down "$SET" >/dev/null 2>&1 || true
    "$FLEET" release "$SET" || true
  fi
}
trap cleanup EXIT
"$FLEET" claim "$SET" "$FLEET_WHO" >/dev/null
if [ "$(curl -s -m 5 "$SHIP_URL/~/host")" != "$PUB" ]; then
  "$FLEET" reset "$SET" "$SNAP"
  echo "settling 110s"
  sleep 110
fi

VERE=$(awk '$1=="stock"{print $2}' "$(dirname "$FLEET")/kernels.conf"); VERE=${VERE/#\~/$HOME}
VERE=$VERE "$ROOT/scripts/hoon-test-kit/ship-cookie.sh" "$PIER" "$SHIP_URL" "$T/wep.jar" >/dev/null
cookie="Cookie: $(awk '$6 ~ /^urbauth/ {print $6"="$7}' "$T/wep.jar")"
NAME="reload-check-$(date +%s)"
RUN="$RANDOM"
publish() {
  curl -s -m 60 -o /dev/null -w '%{http_code}' -H "$cookie" \
    -X POST "$SHIP_URL/apps/lattice/save?path=$NAME" --data-binary "$(printf '# Reload check\n\nrevision %s-%s\n' "$1" "$RUN")"
}
echo "==> urb://$PUB/$NAME, revision 1"
is "publish revision 1" 200 "$(publish 1)"

# The probe runs in every main-frame page of the reader. It keeps its step
# in sessionStorage and reports once, at the end, by navigating to
# /probe/<json>, which the reader logs. Between steps it waits WAIT ms, in
# which this script publishes the next revision.
cat > "$T/probe.js" <<'JS'
(function () {
  var PAGE = 'urb://@PUB@/@NAME@', RUN = '@RUN@', WAIT = 12000;
  var later = function (f, ms) { setTimeout(f, ms); };
  if (location.protocol === 'tauri:' || location.hostname === 'tauri.localhost') {
    later(function () {
      var card = document.getElementById('reader');
      if (card && !card.hidden) document.getElementById('anon').click();
    }, 3000);
    return;
  }
  if (location.port === '' || location.pathname.indexOf('/probe') === 0) return;
  var st = JSON.parse(sessionStorage.getItem('probe') || '{"step":0,"r":{}}');
  var save = function () { sessionStorage.setItem('probe', JSON.stringify(st)); };
  var text = function () { return document.body ? document.body.innerText : ''; };
  var rev = function () { var m = text().match(new RegExp('revision (\\d+)-' + RUN)); return m ? +m[1] : 0; };
  var done = function () { st.step = 99; save(); location.href = '/probe/' + encodeURIComponent(JSON.stringify(st.r)); };
  // what a reload showed, and how long it took
  var took = function (k) { st.r[k] = rev(); st.r[k + 'Ms'] = Date.now() - st.t0; };
  var arm = function (next) { st.step = next; st.t0 = Date.now(); save(); };
  var step = function () {
    var r = st.r;
    if (text().indexOf('Getting ready') >= 0) return;
    if (st.step === 0) {
      st.step = 1; save();
      location.href = '/read?url=' + encodeURIComponent(PAGE);
    } else if (st.step === 1) {
      r.first = rev();
      r.reloadButton = document.querySelector('nav [data-go="reload"]') ? 1 : 0;
      st.step = 2; save();
      // a plain visit, as a link makes: the kept list, so revision 1
      later(function () { location.href = '/read?url=' + encodeURIComponent(PAGE); }, WAIT);
    } else if (st.step === 2) {
      r.plain = rev();
      arm(3);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', ctrlKey: true, bubbles: true, cancelable: true }));
    } else if (st.step === 3) {
      took('ctrlR');
      r.ctrlRAt = location.pathname + location.search;
      st.step = 4; save();
      later(function () {
        arm(5);
        var f = document.querySelector('form.addr');
        f.elements.url.value = PAGE.replace('urb://', '');
        f.requestSubmit();
      }, WAIT);
    } else if (st.step === 5) {
      took('enter');
      st.step = 6; save();
      later(function () { arm(7); location.reload(); }, WAIT);
    } else if (st.step === 7) {
      took('native');
      st.step = 8; save();
      history.back();
    } else if (st.step === 8) {
      r.back = rev();
      done();
    }
  };
  var go = function () {
    st = JSON.parse(sessionStorage.getItem('probe') || '{"step":0,"r":{}}');
    try { step(); } catch (e) { st.r.error = String(e).slice(0, 200); done(); }
  };
  later(go, 1500);
  window.addEventListener('pageshow', function (e) { if (e.persisted) later(go, 1500); });
})();
JS
sed -i "s|@PUB@|$PUB|; s|@NAME@|$NAME|; s|@RUN@|$RUN|" "$T/probe.js"

echo "==> lattice desktop, fresh HOME, no ship"
DISP=:$((90 + RANDOM % 9))
Xvfb "$DISP" -screen 0 1280x900x24 >/dev/null 2>&1 &
XVFB=$!
sleep 1
LOG="$T/app.log"
(
  export HOME="$T/home" XDG_CONFIG_HOME="$T/home/.config" XDG_DATA_HOME="$T/home/.local/share" \
    XDG_CACHE_HOME="$T/home/.cache" DISPLAY="$DISP" LATTICE_LOG=1 LATTICE_PROBE_JS="$T/probe.js" \
    LATTICE_ENGINE_FAKE="new-moon-of:$PUB"
  export DBUS_SESSION_BUS_ADDRESS="unix:path=$T/no-bus"
  exec timeout "${RUNFOR:-240}" "$BIN" > "$LOG" 2>&1
) &
APP=$!

# the next revision once the reader has shown the one before: after the
# first read, then after each fresh read
reads() { grep -c "engine: read urb://$PUB/$NAME in" "$LOG"; }
fresh() { grep -c "reader: fresh read of urb://$PUB/$NAME" "$LOG"; }
wait_for() {
  for _ in $(seq 180); do
    [ "$($1)" -ge "$2" ] && return 0
    kill -0 "$APP" 2>/dev/null || return 1
    sleep 1
  done
  return 1
}
wait_for reads 1 && sleep 2 && is "publish revision 2" 200 "$(publish 2)"
wait_for fresh 1 && sleep 4 && is "publish revision 3" 200 "$(publish 3)"
wait_for fresh 2 && sleep 4 && is "publish revision 4" 200 "$(publish 4)"
for _ in $(seq 120); do
  grep -q "reader: GET /probe/" "$LOG" && break
  kill -0 "$APP" 2>/dev/null || break
  sleep 1
done
sleep 1
kill "$APP" 2>/dev/null; wait "$APP" 2>/dev/null; APP=

report=$(grep -o "reader: GET /probe/[^ ]*" "$LOG" | head -1 | sed 's|reader: GET /probe/||' |
  python3 -I -c 'import sys, urllib.parse; print(urllib.parse.unquote(sys.stdin.read().strip()))')
echo "    report: ${report:-<none>}"
[ -n "$report" ] || { echo "no report. The app said:"; tail -40 "$LOG"; }
r() { python3 -I -c 'import json, sys
try: print(json.loads(sys.argv[1]).get(sys.argv[2], ""))
except Exception: print("")' "$report" "$1"; }
quick() { [ -n "$1" ] && [ "$1" -lt "${QUICK_MS:-5000}" ] && echo yes || echo "no (${1:-none} ms)"; }

enc=$(python3 -I -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "urb://$PUB/$NAME")
is "the page is read" 1 "$(r first)"
is "the bar has a reload button" 1 "$(r reloadButton)"
is "a plain visit after the edit shows the kept revision" 1 "$(r plain)"
is "Ctrl+R shows the edit" 2 "$(r ctrlR)"
is "within a few seconds" yes "$(quick "$(r ctrlRMs)")"
is "and lands on the plain address" "/read?url=$enc" "$(r ctrlRAt)"
is "Enter on the same address shows the next edit" 3 "$(r enter)"
is "within a few seconds" yes "$(quick "$(r enterMs)")"
is "the webview's own reload shows the next" 4 "$(r native)"
is "within a few seconds" yes "$(quick "$(r nativeMs)")"
is "three fresh reads, and back was none" 3 "$(fresh)"
is "the comet stayed one identity" 1 "$(grep -c 'engine: running as' "$LOG")"
grep -E "engine: (running|read urb|expire)|reader: fresh" "$LOG" | head -20 | sed 's/^/    /'
finish
