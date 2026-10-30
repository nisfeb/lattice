#!/usr/bin/env bash
# Two-ship checks for saving a page another ship shared with you through
# /remote-save (the editor's grub tab, "Shared with me"), and for the share
# notice's `notified`. Ship B shares a page with ship A, edit; A saves it.
# Fake fleet ships only, never a real one. Cleans up on both ships.
#
# Usage:  scripts/two-ship-save.sh
# Env:    A_URL, A_COOKIE, B_URL, B_COOKIE, B_PIER, B_STOP, B_START as in
#         scripts/two-ship-links.sh.
#
# Release 74 hung /remote-save until eyre's 600s timeout although the
# write landed in ~2s, and every share notice read notified:false. Each
# save here must answer in seconds, with the outcome it really had.
set -uo pipefail

: "${A_URL:?A_URL}" "${A_COOKIE:?A_COOKIE}" "${B_URL:?B_URL}" "${B_COOKIE:?B_COOKIE}"
B_PIER=${B_PIER:-$HOME/fleet/piers/mun}
b_pids() { pgrep -f -- "--snap-dir $B_PIER( |\$)" | head -1; }
B_STOP=${B_STOP:-'kill -STOP $(b_pids)'}
B_START=${B_START:-'kill -CONT $(b_pids)'}
A="${A_URL%/}/apps/lattice"; B="${B_URL%/}/apps/lattice"
AK="Cookie: $(cat "$A_COOKIE")"; BK="Cookie: $(cat "$B_COOKIE")"
fails=0

ok()   { echo "ok    $1"; }
fail() { echo "FAIL  $1${2:+: $2}"; fails=$((fails+1)); }
is()   { if [ "$2" = "$3" ]; then ok "$1"; else fail "$1" "want [$2] got [$3]"; fi; }
A_()   { curl -s -m 60 -H "$AK" "$@"; }
B_()   { curl -s -m 60 -H "$BK" "$@"; }
code() { curl -s -m 60 -o /dev/null -w '%{http_code}' "$@"; }
within() { awk -v t="$1" -v m="$2" 'BEGIN { print (t <= m) ? "yes" : "no, " t "s" }'; }
entry() { A_ "$A/shared-with-me" | jq -c --arg h "$BSHIP" --arg s /page/x/sdoc/code \
  '[.[] | select(.host==$h and (.path|endswith($s)))][0]'; }
wait_for() {
  local n=$1; shift
  for _ in $(seq 1 "$n"); do
    local v; v=$("$@" 2>/dev/null)
    [ -n "$v" ] && [ "$v" != null ] && { echo "$v"; return 0; }
    sleep 1
  done
  return 1
}
b_up() {
  for _ in $(seq 1 120); do
    [ "$(code -H "$BK" "$B/shared-with-me")" = 200 ] && return 0
    sleep 2
  done
  return 1
}

ASHIP=$(curl -s -m 30 -H "$AK" "${A_URL%/}/~/host")
BSHIP=$(curl -s -m 30 -H "$BK" "${B_URL%/}/~/host")
[ -n "$ASHIP" ] && [ -n "$BSHIP" ] || { echo "FAIL  ships answer /~/host"; exit 1; }

cleanup() {
  eval "$B_START" >/dev/null 2>&1   # never leave B frozen
  local e; e=$(entry)
  if [ -n "$e" ] && [ "$e" != null ]; then
    A_ -o /dev/null -X POST --data-urlencode "host=$BSHIP" \
      --data-urlencode "path=$(jq -r .path <<<"$e")" -G "$A/shared-with-me-del"
  fi
  B_ -o /dev/null -X POST "$B/page-del?name=x"
  B_ -o /dev/null -X POST "$B/share-group-del?name=${ASHIP#\~}"
}

enc() { jq -rn --arg v "$1" '$v|@uri'; }
# save <body> [query]: A's /remote-save of B's x/sdoc, as "<status> <time> <json>"
save() {
  : >/tmp/two-ship-save.out
  curl -s -m 60 -H "$AK" -o /tmp/two-ship-save.out -w '%{http_code} %{time_total}' \
    -X POST "$A/remote-save?ship=$(enc "$BSHIP")&path=$(enc "$PAX")${2:-}" \
    --data-binary "$1"
  echo " $(tr -d '\n' </tmp/two-ship-save.out)"
}

trap cleanup EXIT
cleanup
echo "==> remote-save ($ASHIP saves $BSHIP's x/sdoc)"
is "B makes x/sdoc" 200 "$(code -H "$BK" -X POST "$B/page-save?name=x/sdoc&type=md&new=1" --data-binary '# from B')"
r=$(B_ -X POST "$B/share-file?name=x/sdoc&ship=$ASHIP&mode=edit")
is "B shares it with A, edit" true "$(jq -r .ok <<<"$r")"
is "  ...and A acked the notice: notified" true "$(jq -r .notified <<<"$r")"
e=$(wait_for 30 entry) || { fail "A has the shared-with-me entry"; exit 1; }
ok "A has the shared-with-me entry"
PAX=$(jq -r .path <<<"$e")

read -r st t j <<<"$(save '# saved by A')"
is "save with B online: 200" 200 "$st"
is "  ...in seconds (${t}s)" yes "$(within "$t" 12)"
is "  ...outcome landed" landed "$(jq -r .outcome <<<"$j" 2>/dev/null)"
is "  ...and it is on B" "# saved by A" "$(B_ "$B/page-source?name=x/sdoc" | jq -r .body)"
rv=$(jq -r .rev <<<"$j" 2>/dev/null)

read -r st t j <<<"$(save '# saved by A')"
is "the same text again: 200" 200 "$st"
is "  ...outcome landed, the rev unchanged" "landed $rv" "$(jq -r '"\(.outcome) \(.rev)"' <<<"$j" 2>/dev/null)"

read -r st t j <<<"$(save stale "&base=$((rv - 1))")"
is "a save from a stale base: 409" 409 "$st"
is "  ...outcome conflict" conflict "$(jq -r .outcome <<<"$j" 2>/dev/null)"
is "  ...and B keeps its text" "# saved by A" "$(B_ "$B/page-source?name=x/sdoc" | jq -r .body)"

eval "$B_STOP" >/dev/null 2>&1
is "B is stopped" 000 "$(code -m 5 "$B_URL")"
read -r st t j <<<"$(save '# while B sleeps')"
is "save with B frozen: 504" 504 "$st"
is "  ...within ~10s (${t}s)" yes "$(within "$t" 15)"
is "  ...outcome unreachable" unreachable "$(jq -r .outcome <<<"$j" 2>/dev/null)"
eval "$B_START" >/dev/null 2>&1
b_up && ok "B back up" || fail "B back up"
is "  ...and B kept its text" "# saved by A" "$(B_ "$B/page-source?name=x/sdoc" | jq -r .body)"

echo
[ "$fails" -eq 0 ] && echo "two-ship-save: all passed" || echo "two-ship-save: $fails failed"
[ "$fails" -eq 0 ]
