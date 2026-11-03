#!/usr/bin/env bash
# desktop-shipless.sh: the shipless reader end to end, in the REAL binary.
#
# A first-time user with no ship: a fresh HOME, no config, the app under
# Xvfb. The probe (LATTICE_PROBE_JS) takes the first-run path on the
# manager (types an address into "read without a ship" and clicks Open),
# then on the reader checks the page rendered, the ship actions are shown
# disabled with their reasons, and an invoke from the reader page is
# refused; follows an in-page urb:// link (it must stay in the reader), goes
# back, and finds the read on the reader's home. A publisher's HTML page
# checks the same refusal from inside its sandboxed frame.
#
# The engine reads a fleet ship as a fake moon (LATTICE_ENGINE_FAKE, debug
# builds only): the fake network has no comets. Fake fleet ships only.
#
# Usage:  FLEET_WHO=<you> scripts/desktop-shipless.sh
# Env:    LATTICE_BIN  binary (default desktop/target/debug/lattice-desktop)
#         FLEET        the fleet script; KEEP=1 leaves the set claimed
#         SHOTS        a folder to keep screenshots in
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MATRIX_NO_SHIP=1 . "$ROOT/scripts/lib/matrix.sh"
: "${FLEET_WHO:?set FLEET_WHO to who is claiming the set}"
BIN="${LATTICE_BIN:-$ROOT/desktop/target/debug/lattice-desktop}"
FLEET=${FLEET:-$HOME/software/personal/hoon-development/fleet/fleet}
SET=lattice-gate-peer
PIER=$HOME/fleet/piers/wep
SHIP_URL=http://localhost:8151
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
  rm -rf "$T"
  if [ "${KEEP:-}" != 1 ]; then
    "$FLEET" down "$SET" >/dev/null 2>&1 || true
    "$FLEET" release "$SET" || true
  fi
}
trap cleanup EXIT
"$FLEET" claim "$SET" "$FLEET_WHO" >/dev/null
if [ "$(curl -s -m 5 "$SHIP_URL/~/host")" != "~wep" ]; then
  "$FLEET" reset "$SET" lattice
  echo "settling 110s"
  sleep 110
fi

echo "==> publishing three pages on ~wep"
VERE=$(awk '$1=="stock"{print $2}' "$(dirname "$FLEET")/kernels.conf"); VERE=${VERE/#\~/$HOME}
VERE=$VERE "$ROOT/scripts/hoon-test-kit/ship-cookie.sh" "$PIER" "$SHIP_URL" "$T/wep.jar" >/dev/null
cookie="Cookie: $(awk '$6 ~ /^urbauth/ {print $6"="$7}' "$T/wep.jar")"
publish() {
  curl -s -m 60 -o /dev/null -w '%{http_code}' -H "$cookie" \
    -X POST "$SHIP_URL/apps/lattice/save?path=$1" --data-binary "$2"
}
is "publish shipless-check" 200 "$(publish shipless-check "$(printf '# Shipless check\n\nRead with no ship.\n\n=> urb://~wep/shipless-next The next page\n')")"
is "publish shipless-next" 200 "$(publish shipless-next "$(printf '# The next page\n\nYou followed a link.\n')")"
# a %gmi body that starts with < is a publisher's HTML: the sandboxed frame
is "publish shipless-frame" 200 "$(publish shipless-frame '<!doctype html><title>frame</title><p>publisher html</p>
<script>
var r = ["internals=" + typeof window.__TAURI_INTERNALS__, "tauri=" + typeof window.__TAURI__];
try { r.push("parent=" + typeof window.parent.__TAURI__); } catch (e) { r.push("parent=blocked"); }
var tell = function (s) { new Image().src = "/probe-frame/" + encodeURIComponent(s); };
var go = function () {
  if (window.__TAURI_INTERNALS__) {
    var once = false;
    var then = function (v) { if (!once) { once = true; tell(r.concat("invoke=" + v).join(";")); } };
    window.__TAURI_INTERNALS__.invoke("take_urb_links").then(function () { then("ALLOWED"); },
      function (e) { then("refused:" + String(e).slice(0, 80)); });
    setTimeout(function () { then("no-answer"); }, 3000);
  } else { tell(r.concat("invoke=absent").join(";")); }
};
setTimeout(go, 500);
</script>')"

# The probe runs in every main-frame page of the workspace. It keeps its
# step in sessionStorage (the reader's origin) and reports once, at the
# end, by navigating to /probe/<json>, which the reader logs: a reader page
# allows no fetch or image (default-src 'none').
cat > "$T/probe.js" <<'JS'
(function () {
  var PAGE = 'urb://~wep/shipless-check';
  var later = function (f, ms) { setTimeout(f, ms); };
  if (location.protocol === 'tauri:' || location.hostname === 'tauri.localhost') {
    // the manager, first run: the card, then Open
    later(function () {
      var card = document.getElementById('reader');
      var form = document.getElementById('connect');
      if (!card || card.hidden) return;
      window.__probeCardFirst = !!(card.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING);
      document.getElementById('read-url').value = PAGE;
      document.querySelector('#read-form button.primary').click();
    }, 3000);
    return;
  }
  if (location.port === '' || location.pathname.indexOf('/probe') === 0) return;
  var st = JSON.parse(sessionStorage.getItem('probe') || '{"step":0,"r":{}}');
  var save = function () { sessionStorage.setItem('probe', JSON.stringify(st)); };
  var q = function (s) { return document.querySelector(s); };
  var text = function () { return document.body ? document.body.innerText : ''; };
  var done = function () {
    st.step = 99; save();
    location.href = '/probe/' + encodeURIComponent(JSON.stringify(st.r));
  };
  var go = function () {
    st = JSON.parse(sessionStorage.getItem('probe') || '{"step":0,"r":{}}');
    try { step(); } catch (e) { st.r.error = String(e).slice(0, 200); done(); }
  };
  later(go, 2500);
  // back may restore the page from the cache, which runs no script again
  window.addEventListener('pageshow', function (e) { if (e.persisted) later(go, 1500); });
  var step = function () {
    var r = st.r;
    if (st.step === 0) {
      if (text().indexOf('Getting ready to read') >= 0) { r.sawSetup = 1; save(); return; }
      r.title = document.title;
      r.rendered = text().indexOf('Read with no ship.') >= 0 ? 1 : 0;
      r.disabled = document.querySelectorAll('.actions button[disabled]').length;
      r.reasons = Array.prototype.map.call(document.querySelectorAll('.actions .why'),
        function (e) { return e.textContent; }).join('|');
      r.tauri = typeof window.__TAURI__;
      var inv = window.__TAURI_INTERNALS__;
      var next = function () {
        st.step = 1; save();
        var a = q('a[href*="shipless-next"]');
        r.link = a ? a.getAttribute('href') : 'none'; save();
        // a script's click is not a user's, so the probe follows the href
        if (a) location.href = a.href; else done();
      };
      // open_manager would take the window off the reader, so a page that
      // could run it would never report at all; a refused one answers, or
      // (on some webviews) never does, and the probe goes on after 3 s
      var once = false;
      var then = function (v) { if (once) return; once = true; r.invoke = v; save(); next(); };
      if (inv) {
        inv.invoke('open_manager', { section: null }).then(function () { then('ALLOWED'); },
          function (e) { then('refused:' + String(e).slice(0, 80)); });
        later(function () { then('no-answer'); }, 3000);
      } else { then('absent'); }
    } else if (st.step === 1) {
      r.followed = location.pathname + location.search;
      r.followedRendered = text().indexOf('You followed a link.') >= 0 ? 1 : 0;
      st.step = 2; save();
      history.back();
    } else if (st.step === 2) {
      r.back = text().indexOf('Read with no ship.') >= 0 ? 1 : 0;
      st.step = 3; save();
      location.href = '/read?url=' + encodeURIComponent('urb://~wep/shipless-frame');
    } else if (st.step === 3) {
      r.frame = document.querySelector('iframe.pub') ? (q('iframe.pub').getAttribute('sandbox') || 'nosandbox') : 'none';
      st.step = 4; save();
      later(function () { location.href = '/'; }, 3000);
    } else if (st.step === 4) {
      r.home = text().indexOf('Shipless check') >= 0 && text().indexOf('Recently read') >= 0 ? 1 : 0;
      r.start = text().indexOf('Start here') >= 0 ? 1 : 0;
      st.step = 5; save();
      // a ship that is not running: tried again, then said plainly
      location.href = '/read?url=' + encodeURIComponent('urb://~nec/shipless-offline');
    } else if (st.step === 5) {
      r.offline = text().indexOf("publisher of this page didn't answer") >= 0 ? 1 : 0;
      r.retry = q('[data-go="retry"]') ? 1 : 0;
      done();
    }
  };
})();
JS

echo "==> lattice desktop, fresh HOME, no ship"
DISP=:$((90 + RANDOM % 9))
Xvfb "$DISP" -screen 0 1280x900x24 >/dev/null 2>&1 &
XVFB=$!
sleep 1
LOG="$T/app.log"
(
  export HOME="$T/home" XDG_CONFIG_HOME="$T/home/.config" XDG_DATA_HOME="$T/home/.local/share" \
    XDG_CACHE_HOME="$T/home/.cache" DISPLAY="$DISP" LATTICE_LOG=1 LATTICE_PROBE_JS="$T/probe.js" \
    LATTICE_ENGINE_FAKE="new-moon-of:~wep"
  export DBUS_SESSION_BUS_ADDRESS="unix:path=$T/no-bus"
  timeout "${RUNFOR:-90}" "$BIN" > "$LOG" 2>&1
) &
APP=$!
if [ -n "${SHOTS:-}" ]; then
  mkdir -p "$SHOTS"
  ( for i in $(seq 1 40); do sleep 2; import -display "$DISP" -window root "$SHOTS/shot-$(printf %02d "$i").png" 2>/dev/null; done ) &
fi
for _ in $(seq 90); do
  grep -q "reader: GET /probe/" "$LOG" && break
  kill -0 "$APP" 2>/dev/null || break
  sleep 1
done
sleep 2
kill "$APP" 2>/dev/null; wait "$APP" 2>/dev/null

report=$(grep -o "reader: GET /probe/[^ ]*" "$LOG" | head -1 | sed 's|reader: GET /probe/||' |
  python3 -I -c 'import sys, urllib.parse; print(urllib.parse.unquote(sys.stdin.read().strip()))')
frame=$(grep -o "reader: GET /probe-frame/[^ ]*" "$LOG" | head -1 | sed 's|reader: GET /probe-frame/||' |
  python3 -I -c 'import sys, urllib.parse; print(urllib.parse.unquote(sys.stdin.read().strip()))')
echo "    report: ${report:-<none>}"
echo "    frame:  ${frame:-<none>}"
[ -n "$report" ] || { echo "no report. The app said:"; tail -40 "$LOG"; }
r() { python3 -I -c 'import json, sys
try: print(json.loads(sys.argv[1]).get(sys.argv[2], ""))
except Exception: print("")' "$report" "$1"; }

is "the first-run card opened the reader" 1 "$(grep -c 'reader: open /read?url=urb%3A%2F%2F~wep%2Fshipless-check' "$LOG")"
is "the engine ran as a moon of ~wep, made once" 1 "$(grep -c 'engine: running as ~[a-z-]*-dozzod-dozwep' "$LOG")"
ran=$(grep -n -m1 'engine: running as' "$LOG" | cut -d: -f1); opened=$(grep -n -m1 'reader: open /read' "$LOG" | cut -d: -f1)
is "and got ready while the first-run page was up, before Open" yes "$([ -n "$ran" ] && [ -n "$opened" ] && [ "$ran" -lt "$opened" ] && echo yes || echo "no ($ran, $opened)")"
is "the page rendered" 1 "$(r rendered)"
is "titled by its first heading" "Shipless check" "$(r title)"
is "three ship actions shown disabled" 3 "$(r disabled)"
is "each with its reason" "Connect a ship to bookmark|Connect a ship to comment|Connect a ship to follow" "$(r reasons)"
inv=$(r invoke)
is "an invoke from the reader page is refused" yes "$(case "$inv" in refused:*|absent|no-answer) echo yes;; *) echo "no ($inv)";; esac)"
is "an in-page urb:// link stays in the reader" "/read?url=urb%3A%2F%2F~wep%2Fshipless-next" "$(r followed)"
is "and its page renders" 1 "$(r followedRendered)"
is "back returns to the first page" 1 "$(r back)"
is "a publisher's HTML is in a sandboxed frame" "allow-scripts allow-forms allow-popups allow-top-navigation-by-user-activation" "$(r frame)"
is "an invoke from inside the frame is refused" yes "$(case "$frame" in *invoke=refused:*|*invoke=absent*|*invoke=no-answer*) echo yes;; *) echo "no ($frame)";; esac)"
is "the home lists the read, under Recently read" 1 "$(r home)"
is "and offers the start list" 1 "$(r start)"
is "a ship that is not running is said plainly" 1 "$(r offline)"
is "with a way to try again" 1 "$(r retry)"
grep -E "engine: |reader: (open|listening)" "$LOG" | head -8 | sed 's/^/    /'
finish
