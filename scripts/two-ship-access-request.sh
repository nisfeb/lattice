#!/usr/bin/env bash
# Two-ship checks for share notifications and edit access requests
# (lattice wiki specs/2026-11-08-share-notify-and-access-requests).
#
#   1. A shares page P with B for read: B's inbox has a badged %share line
#   2. B asks A for edit with a note: A lists the request and has an %ask
#      line; B asks again and A still has one request, with the new note
#   3. A approves: A's group for B grants P for edit, B hears the yes in
#      its inbox (no quiet mode-change line), its shared with me lists P
#      for edit, and B's save of P lands on A
#   4. A shares Q for read, B asks, A denies: B hears the no, and B asking
#      again inside the cooldown files nothing on A
#   5. B asks about a page it does not read: dropped
#   6. A bans B, B asks about R: dropped
#
# Fake fleet ships only, never a real one. Cleans up after itself.
#
# Env:    A_URL, A_COOKIE, B_URL, B_COOKIE as two-ship-links.sh takes them.
# Prints one ok/FAIL line per check, exits non-zero on any FAIL.
set -uo pipefail

: "${A_URL:?A_URL}" "${A_COOKIE:?A_COOKIE}" "${B_URL:?B_URL}" "${B_COOKIE:?B_COOKIE}"
A="${A_URL%/}/apps/lattice"; B="${B_URL%/}/apps/lattice"
AK="Cookie: $(cat "$A_COOKIE")"; BK="Cookie: $(cat "$B_COOKIE")"
fails=0
ok()   { echo "ok    $1"; }
fail() { echo "FAIL  $1${2:+: $2}"; fails=$((fails+1)); }
is()   { if [ "$2" = "$3" ]; then ok "$1"; else fail "$1" "want [$2] got [$3]"; fi; }
A_()   { curl -s -m 90 -H "$AK" "$@"; }
B_()   { curl -s -m 90 -H "$BK" "$@"; }
code() { curl -s -m 90 -o /dev/null -w '%{http_code}' "$@"; }
until_() { local n=$1; shift; for _ in $(seq 1 "$n"); do "$@" && return 0; sleep 1; done; return 1; }

ASHIP=$(curl -s -m 30 -H "$AK" "${A_URL%/}/~/host")
BSHIP=$(curl -s -m 30 -H "$BK" "${B_URL%/}/~/host")
[ -n "$ASHIP" ] && [ -n "$BSHIP" ] || { echo "FAIL  ships answer /~/host"; exit 1; }
T="ask$RANDOM"
BG=${BSHIP#\~}

cleanup() {
  A_ -o /dev/null -X POST "$A/unban?ship=$BSHIP"
  A_ -o /dev/null -X POST "$A/share-group-del?name=$BG"
  for n in p q r s; do A_ -o /dev/null -X POST "$A/page-del?name=$T/$n"; done
  A_ -o /dev/null -X POST "$A/page-del?name=$T"
  B_ "$B/shared-with-me" | jq -r --arg h "$ASHIP" --arg t "/page/$T/" \
    '.[] | select(.host==$h and (.path|contains($t))) | .path' |
  while read -r pa; do
    B_ -o /dev/null -X POST -G --data-urlencode "host=$ASHIP" --data-urlencode "path=$pa" "$B/shared-with-me-del"
  done
  A_ -o /dev/null -X POST "$A/notify-read?all=1"
  B_ -o /dev/null -X POST "$B/notify-read?all=1"
}
trap cleanup EXIT

for n in p q r s; do
  A_ -o /dev/null -X POST "$A/page-save?name=$T/$n&type=md&new=1" --data-binary "# $n"
done
SB=$(A_ "$A/streams" | jq -r .base)
pax() { echo "$SB/page/$T/$1/code"; }
P=$(pax p); Q=$(pax q); R=$(pax r); S=$(pax s)
is "B starts from a read inbox" 200 "$(code -H "$BK" -X POST "$B/notify-read?all=1")"
is "A starts from a read inbox" 200 "$(code -H "$AK" -X POST "$A/notify-read?all=1")"

bitem() { B_ "$B/notify" | jq -c --arg k "$1" --arg w "$2" '[.items[] | select(.kind==$k and .where==$w)][0] // empty'; }
aitem() { A_ "$A/notify" | jq -c --arg k "$1" --arg w "$2" '[.items[] | select(.kind==$k and .where==$w)][0] // empty'; }
bcount() { B_ "$B/notify" | jq --arg k "$1" --arg w "$2" '[.items[] | select(.kind==$k and .where==$w)] | length'; }
acount() { A_ "$A/notify" | jq --arg k "$1" --arg w "$2" '[.items[] | select(.kind==$k and .where==$w)] | length'; }
pending() { A_ "$A/access-requests" | jq -c --arg s "$BSHIP" --arg p "$1" '[.pending[] | select(.ship==$s and .path==$p)]'; }
enc() { jq -rn --arg v "$1" '$v|@uri'; }
# askb <path> <note>: B asks A for edit; the note is the body, so the
# query is built by hand (curl -G would move the body into it)
askb() { B_ -o /dev/null -w '%{http_code}' -X POST \
  "$B/access-request?host=$(enc "$ASHIP")&path=$(enc "$1")" --data-binary "$2"; }
# mode <name>: what A's group for B grants the page: edit, read or none
mode() { A_ "$A/share-groups" | jq -r --arg g "$BG" --arg t "/page/$T/$1" '
  [.[] | select(.name==$g)][0] // {peek: [], make: []} |
  if (.make | any(endswith($t))) then "edit"
  elif (.peek | any(endswith($t))) then "read" else "none" end'; }

echo "==> 1. A shares P with B for read"
A_ -o /dev/null -X POST "$A/share-file?name=$T/p&ship=$BSHIP&mode=read"
has_share() { [ -n "$(bitem share "$P")" ]; }
if until_ 60 has_share; then ok "B's inbox lists the share"; else fail "B's inbox lists the share" "$(B_ "$B/notify" | head -c 400)"; fi
it=$(bitem share "$P")
is "it names A"                 "$ASHIP" "$(jq -r .who <<<"$it")"
is "it is unread (badged)"      false "$(jq -r .read <<<"$it")"
is "it reads as a sentence"     "$ASHIP shared $T/p with you (read)" "$(jq -r .body <<<"$it")"
n=$(B_ "$B/notify-count" | jq -r .unread)
if [ "${n:-0}" -ge 1 ]; then ok "B's badge counts it"; else fail "B's badge counts it" "$n"; fi

echo "==> 2. B asks for edit"
is "B asks" 200 "$(askb "$P" "please let me fix typos")"
one_pending() { [ "$(pending "$P" | jq length)" = 1 ]; }
if until_ 60 one_pending; then ok "A lists the request"; else fail "A lists the request" "$(A_ "$A/access-requests")"; fi
is "with the note" "please let me fix typos" "$(pending "$P" | jq -r '.[0].note')"
is "and its name"  "$T/p" "$(pending "$P" | jq -r '.[0].name')"
is "A has one ask line, unread" false "$(aitem ask "$P" | jq -r .read)"
is "B lists its ask as sent" 1 "$(B_ "$B/access-requests" | jq --arg p "$P" '[.sent[] | select(.path==$p)] | length')"
is "B asks again" 200 "$(askb "$P" "second note")"
new_note() { [ "$(pending "$P" | jq -r '.[0].note')" = "second note" ]; }
if until_ 60 new_note; then ok "the second ask replaces the first"; else fail "the second ask replaces the first" "$(pending "$P")"; fi
is "still one request" 1 "$(pending "$P" | jq length)"
is "still one ask line" 1 "$(acount ask "$P")"

echo "==> 3. A approves"
is "approve" 200 "$(code -H "$AK" -X POST -G --data-urlencode "ship=$BSHIP" --data-urlencode "path=$P" --data "do=approve" "$A/access-answer")"
is "the request is gone" 0 "$(pending "$P" | jq length)"
is "A's group for B grants P for edit" edit "$(mode p)"
is "A's ask line is read" true "$(aitem ask "$P" | jq -r .read)"
yes_line() { [ "$(bitem asked "$P" | jq -r .title)" = yes ]; }
if until_ 60 yes_line; then ok "B hears the yes"; else fail "B hears the yes" "$(B_ "$B/notify" | head -c 400)"; fi
is "the yes is badged" false "$(bitem asked "$P" | jq -r .read)"
is "no quiet mode line beside it" 0 "$(bcount reshare "$P")"
is "B's shared with me lists P for edit" edit "$(B_ "$B/shared-with-me" | jq -r --arg p "$P" '.[] | select(.path==$p) | .mode')"
is "B's sent list is empty" 0 "$(B_ "$B/access-requests" | jq --arg p "$P" '[.sent[] | select(.path==$p)] | length')"
rev=$(B_ -G --data-urlencode "ship=$ASHIP" --data-urlencode "path=$P" "$B/browse-file" | jq -r '.rev // empty')
out=$(B_ -X POST "$B/remote-save?ship=$(enc "$ASHIP")&path=$(enc "$P")${rev:+&base=$rev}" \
  --data-binary "# p, edited by $BSHIP")
is "B's save of P lands" landed "$(jq -r '.outcome // (if .ok then "landed" else . end)' <<<"$out" 2>/dev/null || echo "$out")"
saved() { A_ "$A/page-source?name=$T/p" | jq -r .body | grep -q "edited by $BSHIP"; }
if until_ 30 saved; then ok "A's page has B's edit"; else fail "A's page has B's edit" "$(A_ "$A/page-source?name=$T/p" | head -c 200)"; fi

echo "==> 4. A shares Q for read, B asks, A denies"
A_ -o /dev/null -X POST "$A/share-file?name=$T/q&ship=$BSHIP&mode=read"
has_q() { B_ "$B/shared-with-me" | jq -e --arg p "$Q" 'any(.[]; .path==$p)' >/dev/null; }
until_ 60 has_q || fail "B lists Q"
is "B asks for Q" 200 "$(askb "$Q" "")"
q_pending() { [ "$(pending "$Q" | jq length)" = 1 ]; }
if until_ 60 q_pending; then ok "A lists it"; else fail "A lists it" "$(A_ "$A/access-requests")"; fi
is "deny" 200 "$(code -H "$AK" -X POST -G --data-urlencode "ship=$BSHIP" --data-urlencode "path=$Q" --data "do=deny" "$A/access-answer")"
is "the request is gone" 0 "$(pending "$Q" | jq length)"
is "B still reads Q only" read "$(mode q)"
no_line() { [ "$(bitem asked "$Q" | jq -r .title)" = no ]; }
if until_ 60 no_line; then ok "B hears the no"; else fail "B hears the no" "$(B_ "$B/notify" | head -c 400)"; fi
is "B's sent list drops it" 0 "$(B_ "$B/access-requests" | jq --arg p "$Q" '[.sent[] | select(.path==$p)] | length')"
is "B asks again inside the cooldown" 200 "$(askb "$Q" "again")"
sleep 8
is "A files nothing" 0 "$(pending "$Q" | jq length)"
is "nor an ask line" 1 "$(acount ask "$Q")"
is "denying it again finds nothing" 404 "$(code -H "$AK" -X POST -G --data-urlencode "ship=$BSHIP" --data-urlencode "path=$Q" --data "do=deny" "$A/access-answer")"

echo "==> 5. B asks about a page it does not read"
askb "$S" "" >/dev/null
sleep 8
is "dropped" 0 "$(pending "$S" | jq length)"
is "no ask line" 0 "$(acount ask "$S")"

echo "==> 6. a banned ship's ask is dropped"
A_ -o /dev/null -X POST "$A/share-file?name=$T/r&ship=$BSHIP&mode=read"
has_r() { B_ "$B/shared-with-me" | jq -e --arg p "$R" 'any(.[]; .path==$p)' >/dev/null; }
until_ 60 has_r || fail "B lists R"
is "ban B" 200 "$(code -H "$AK" -X POST "$A/ban?ship=$BSHIP")"
askb "$R" "let me in" >/dev/null
sleep 8
is "dropped" 0 "$(pending "$R" | jq length)"
is "no ask line" 0 "$(acount ask "$R")"
is "unban B" 200 "$(code -H "$AK" -X POST "$A/unban?ship=$BSHIP")"

echo "$fails failure(s)"
exit $((fails > 0))
