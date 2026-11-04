#!/usr/bin/env bash
# desktop-shipless.sh: the shipless reader end to end, in the REAL binary.
#
# A first-time user with no node: a fresh HOME, no config, the app under
# Xvfb. The probe (LATTICE_PROBE_JS) chooses "use anonymously" on the
# manager, beside the connect form, and must land on the reader's start
# page. From there it opens a published page by its address, checks it
# rendered, that bookmarks, follows and hosting are shown disabled with
# their reasons, and that an invoke from the reader page is refused; then
# posts a comment, which must arrive on the publisher's ship with the
# reader identity as its author. It follows an in-page urb:// link (it must
# stay in the reader), goes back, and finds the read on the reader's home.
# A publisher's HTML page checks the same refusal from inside its sandboxed
# frame.
#
# The engine reads a fleet ship as a fake moon (LATTICE_ENGINE_FAKE, debug
# builds only): the fake network has no comets. Fake fleet ships only.
#
# Usage:  FLEET_WHO=<you> scripts/desktop-shipless.sh
# Env:    LATTICE_BIN  binary (default desktop/target/debug/lattice-desktop)
#         FLEET        the fleet script; KEEP=1 leaves the set claimed
#         FLEET_SET, FLEET_SNAP, PUB, PIER, SHIP_URL  the publisher (default
#                      lattice-gate-peer reset to lattice: ~wep on 8151)
#         SHOTS        a folder to keep screenshots in
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib/hygiene.sh"   # no cores, marked children
lattice_disk_ok || exit 2
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
  lattice_reap
  [ -n "${XVFB:-}" ] && kill "$XVFB" 2>/dev/null
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

echo "==> three pages on $PUB, comments on for the first"
VERE=$(awk '$1=="stock"{print $2}' "$(dirname "$FLEET")/kernels.conf"); VERE=${VERE/#\~/$HOME}
VERE=$VERE "$ROOT/scripts/hoon-test-kit/ship-cookie.sh" "$PIER" "$SHIP_URL" "$T/wep.jar" >/dev/null
cookie="Cookie: $(awk '$6 ~ /^urbauth/ {print $6"="$7}' "$T/wep.jar")"
publish() {
  curl -s -m 60 -o /dev/null -w '%{http_code}' -H "$cookie" \
    -X POST "$SHIP_URL/apps/lattice/save?path=$1" --data-binary "$2"
}
# a page proper (not only a /pub entry, as /save makes): lattice takes a
# comment only on a page that exists and has comments on
is "make shipless-check" 200 "$(curl -s -m 60 -o /dev/null -w '%{http_code}' -H "$cookie" -X POST \
  "$SHIP_URL/apps/lattice/page-save?name=shipless-check&type=gmi&new=1" \
  --data-binary "$(printf '# Shipless check\n\nRead with no ship.\n\n=> urb://%s/shipless-next The next page\n' "$PUB")")"
is "publish it" 200 "$(curl -s -m 60 -o /dev/null -w '%{http_code}' -H "$cookie" -X POST \
  "$SHIP_URL/apps/lattice/page-share?name=shipless-check&mode=urbit")"
is "comments on for it" 200 "$(curl -s -m 30 -o /dev/null -w '%{http_code}' -H "$cookie" \
  -X POST "$SHIP_URL/apps/lattice/page-comments?name=shipless-check&on=1")"
NONCE="anon comment $(date +%s)-$RANDOM"
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
  var PUB = '@PUB@', PAGE = 'urb://' + PUB + '/shipless-check', NONCE = '@NONCE@';
  var later = function (f, ms) { setTimeout(f, ms); };
  if (location.protocol === 'tauri:' || location.hostname === 'tauri.localhost') {
    // the manager, first run: "use anonymously", beside the connect form
    later(function () {
      var card = document.getElementById('reader');
      if (!card || card.hidden) return;
      document.getElementById('anon').click();
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
      // where choosing the option landed: the start page
      r.landed = location.pathname;
      r.landedStart = text().indexOf('Start here') >= 0 ? 1 : 0;
      st.step = 1; save();
      // as typed into the address bar (a script's submit is not a user's)
      location.href = '/read?url=' + encodeURIComponent(PAGE);
    } else if (st.step === 1) {
      if (text().indexOf('Getting ready') >= 0) { r.sawSetup = 1; save(); return; }
      r.title = document.title;
      r.rendered = text().indexOf('Read with no ship.') >= 0 ? 1 : 0;
      r.disabled = document.querySelectorAll('.actions button[disabled]').length;
      r.reasons = Array.prototype.map.call(document.querySelectorAll('.actions .why'),
        function (e) { return e.textContent; }).join('|');
      r.who = q('.talk .who') ? q('.talk .who').textContent : 'none';
      r.tauri = typeof window.__TAURI__;
      var inv = window.__TAURI_INTERNALS__;
      var next = function () {
        st.step = 2; save();
        var f = q('form.talk-form');
        if (!f) { r.box = 'none'; done(); return; }
        q('form.talk-form textarea').value = NONCE;
        f.submit();
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
    } else if (st.step === 2) {
      // back on the page after the comment, which says what became of it
      r.afterComment = location.pathname + location.search;
      var n = q('.talk .note');
      r.note = n ? n.textContent : 'none';
      st.step = 3; save();
      var a = q('a[href*="shipless-next"]');
      r.link = a ? a.getAttribute('href') : 'none'; save();
      // a script's click is not a user's, so the probe follows the href
      if (a) location.href = a.href; else done();
    } else if (st.step === 3) {
      r.followed = location.pathname + location.search;
      r.followedRendered = text().indexOf('You followed a link.') >= 0 ? 1 : 0;
      st.step = 4; save();
      history.back();
    } else if (st.step === 4) {
      r.back = text().indexOf('Read with no ship.') >= 0 ? 1 : 0;
      st.step = 5; save();
      location.href = '/read?url=' + encodeURIComponent('urb://' + PUB + '/shipless-frame');
    } else if (st.step === 5) {
      r.frame = document.querySelector('iframe.pub') ? (q('iframe.pub').getAttribute('sandbox') || 'nosandbox') : 'none';
      st.step = 6; save();
      later(function () { location.href = '/'; }, 3000);
    } else if (st.step === 6) {
      r.home = text().indexOf('Shipless check') >= 0 && text().indexOf('Recently read') >= 0 ? 1 : 0;
      r.start = text().indexOf('Start here') >= 0 ? 1 : 0;
      st.step = 7; save();
      // a ship that is not running: tried again, then said plainly
      location.href = '/read?url=' + encodeURIComponent('urb://~nec/shipless-offline');
    } else if (st.step === 7) {
      r.offline = text().indexOf("publisher of this page didn't answer") >= 0 ? 1 : 0;
      r.retry = q('[data-go="retry"]') ? 1 : 0;
      done();
    }
  };
})();
JS
sed -i "s|@PUB@|$PUB|; s|@NONCE@|$NONCE|" "$T/probe.js"

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
  timeout "${RUNFOR:-120}" "$BIN" > "$LOG" 2>&1
) &
APP=$!
if [ -n "${SHOTS:-}" ]; then
  mkdir -p "$SHOTS"
  ( for i in $(seq 1 40); do sleep 2; import -display "$DISP" -window root "$SHOTS/shot-$(printf %02d "$i").png" 2>/dev/null; done ) &
fi
for _ in $(seq 120); do
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

enc=$(python3 -I -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "urb://$PUB/shipless-check")
moon=$(grep -o -m1 'engine: running as ~[a-z-]*' "$LOG" | sed 's/engine: running as //')
pubtail=${PUB#\~}
is "use anonymously opened the reader on its start page" 1 "$(grep -c 'reader: open /$' "$LOG")"
is "and landed there" "/" "$(r landed)"
is "which offers the start list" 1 "$(r landedStart)"
is "the engine ran as a moon of $PUB, made once" 1 "$(grep -c "engine: running as ~[a-z-]*-dozzod-doz$pubtail" "$LOG")"
ran=$(grep -n -m1 'engine: running as' "$LOG" | cut -d: -f1); opened=$(grep -n -m1 'reader: open /' "$LOG" | cut -d: -f1)
is "and got ready while the first-run page was up, before the choice" yes "$([ -n "$ran" ] && [ -n "$opened" ] && [ "$ran" -lt "$opened" ] && echo yes || echo "no ($ran, $opened)")"
is "the page rendered" 1 "$(r rendered)"
is "titled by its first heading" "Shipless check" "$(r title)"
is "three node actions shown disabled" 3 "$(r disabled)"
is "each with its reason" "Connect a node to bookmark|Connect a node to follow|Hosting pages needs a node" "$(r reasons)"
is "the comment box names the reader identity" "$moon" "$(r who)"
inv=$(r invoke)
is "an invoke from the reader page is refused" yes "$(case "$inv" in refused:*|absent|no-answer) echo yes;; *) echo "no ($inv)";; esac)"
is "the comment was sent" 1 "$(grep -c "reader: comment on urb://$PUB/shipless-check: sent" "$LOG")"
is "and the page came back to say so" "/read?url=$enc" "$(r afterComment)"
has "in plain words" "Sent to $PUB." "$(r note)"
echo "==> the comment on $PUB"
inbox=""
for _ in $(seq 20); do
  inbox=$(curl -s -m 30 -H "$cookie" "$SHIP_URL/apps/lattice/comments-inbox")
  printf '%s' "$inbox" | grep -qF "$NONCE" && break
  sleep 1
done
got=$(python3 -I -c 'import json, sys
try:
    items = json.loads(sys.argv[1]).get("items", [])
except Exception:
    items = []
hit = [i for i in items if i.get("body") == sys.argv[2]]
print("%s %s" % (hit[0]["page"], hit[0]["author"]) if hit else "none")' "$inbox" "$NONCE")
is "it arrived on $PUB, on the page, with the reader identity as its author" "shipless-check $moon" "${got#/}"
is "an in-page urb:// link stays in the reader" "/read?url=urb%3A%2F%2F${PUB}%2Fshipless-next" "$(r followed)"
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
