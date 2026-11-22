#!/usr/bin/env bash
# Two-ship checks for what another ship can make a host do through its
# public inboxes, and for what outlives a ship's access to a private
# board. A hosts, B is the other ship. B's actions are poked from a khan
# thread on its pier, so nothing here rests on B's own lattice routes.
#
#   1. a private board: an invited B posts and is told of a reply to its
#      thread. Once revoked it is told of no further reply. Banned and
#      unbanned, it is off the roster and its comment does not land
#   2. forum pokes that name boards A does not host get no refusal note
#      back, however many names, and a real board's refusal is still noted
#   3. a refusal note of any size is stored clipped, and one whose board
#      is no board name is dropped
#   4. a comment poke with a path of thousands of segments costs A
#      nothing: a real comment sent after it lands at once
#
# Fake ships only, never a real one. Cleans up after itself.
#
# Env:    A_URL, A_COOKIE, B_URL, B_COOKIE as two-ship-links.sh takes them,
#         B_PIER and VERE for B's pokes (exits 2 without them).
# Prints one ok/FAIL line per check, exits non-zero on any FAIL.
set -uo pipefail

: "${A_URL:?A_URL}" "${A_COOKIE:?A_COOKIE}" "${B_URL:?B_URL}" "${B_COOKIE:?B_COOKIE}"
[ -n "${B_PIER:-}" ] && [ -n "${VERE:-}" ] || { echo "B_PIER and VERE must be set" >&2; exit 2; }
A="${A_URL%/}/apps/lattice"; B="${B_URL%/}/apps/lattice"
AK="Cookie: $(cat "$A_COOKIE")"; BK="Cookie: $(cat "$B_COOKIE")"
fails=0
ok()   { echo "ok    $1"; }
fail() { echo "FAIL  $1${2:+: $2}"; fails=$((fails+1)); }
is()   { if [ "$2" = "$3" ]; then ok "$1"; else fail "$1" "want [$2] got [$3]"; fi; }
A_()   { curl -s -m 60 -H "$AK" "$@"; }
B_()   { curl -s -m 60 -H "$BK" "$@"; }
code() { curl -s -m 60 -o /dev/null -w '%{http_code}' "$@"; }
until_() { local n=$1; shift; for _ in $(seq 1 "$n"); do "$@" && return 0; sleep 1; done; return 1; }

ASHIP=$(sed -n 's/^urbauth-\(~[a-z-]*\)=.*/\1/p' "$A_COOKIE")
BSHIP=$(sed -n 's/^urbauth-\(~[a-z-]*\)=.*/\1/p' "$B_COOKIE")
BASE=$(A_ "$A/streams" | jq -r .base)
PB="gp$RANDOM"; UB="gu$RANDOM"; P="gc$RANDOM"

cleanup() {
  A_ -o /dev/null -X POST "$A/unban?ship=$BSHIP"
  A_ -o /dev/null -X POST "$A/forum/$PB/mod/delete"
  A_ -o /dev/null -X POST "$A/forum/$UB/mod/delete"
  A_ -o /dev/null -X POST "$A/page-del?name=$P"
  A_ -o /dev/null -X POST "$A/forum-notes/clear"
  B_ -o /dev/null -X POST "$B/forum-notes/clear"
}
trap cleanup EXIT

# poke <inbox> <mark> <hoon noun>: B pokes one of A's inboxes. Prints
# %sent once A acked it.
poke() {
  local hoon
  hoon="=/  m  (strand ,vase)  ;<  ~  bind:m  (poke [$ASHIP %grubbery] %grubbery-load !>([[/guard %& (stab '$BASE') %'$1'] [%poke [/lattice %$2] $3]]))  (pure:m !>(%sent))"
  hoon=${hoon//\\/\\\\}; hoon=${hoon//\'/\\\'}
  printf '%s\n' "[0 %fyrd [%base %khan-eval %noun [%ted-eval '$hoon']]]" |
    "$VERE" eval --jam -n 2>/dev/null |
    socat -T 300 -,ignoreeof UNIX-CONNECT:"$B_PIER/.urb/conn.sock" 2>/dev/null |
    "$VERE" eval --cue -n 2>/dev/null | tail -1
}
forum() { poke forum.sig forum-action "$1"; }
thread()  { A_ "$A/urb-read?url=urb%3A%2F%2F$ASHIP%2Fforum%2F$PB%2F$1"; }
bodies()  { thread "$1" | jq -r '.comments[]?.body'; }
bnotify() { B_ "$B/notify" | jq -r '.items[] | .body'; }
bnotes()  { B_ "$B/forum-notes"; }
anotes()  { A_ "$A/forum-notes"; }
# B is no mod, so A holds it to one action a cooldown, which doubles
# unless four cooldowns pass. 45 s between B's forum actions keeps it at
# its 10 s base (two-ship-forum.sh says why).
lastb=-100
pace() { local w=$((lastb + 45 - SECONDS)); if [ "$w" -gt 0 ]; then sleep "$w"; fi; lastb=$SECONDS; }

echo "==> 1. a private board, B invited"
is "board made" 303 "$(code -H "$AK" -X POST "$A/forum/_new" --data "name=$PB&title=Guard+$PB&role=poster")"
is "set private" 303 "$(code -H "$AK" -X POST "$A/forum/$PB/mod/public")"
is "A posts thread 1" 303 "$(code -H "$AK" -X POST "$A/forum/$PB/submit" --data "title=Host+thread&body=by+the+host")"
r=$(A_ -X POST "$A/forum-invite?board=$PB&ship=$BSHIP")
grep -q '"ok":true' <<<"$r" && ok "B invited" || fail "B invited" "$r"
sleep 2
pace; forum "[%new-post %$PB 'Member thread' ~ \`'by the member']" >/dev/null
b_thread() { [ "$(thread 2 | jq -r '.post.title')" = "Member thread" ]; }
if until_ 90 b_thread; then ok "the member's thread lands"; else fail "the member's thread lands" "$(thread 2 | head -c 200)"; fi
M1="told$RANDOM while a member"
is "A replies to B's thread" 303 "$(code -H "$AK" -X POST "$A/forum/$PB/2/comment" --data "body=${M1// /+}")"
told() { bnotify | grep -qF "$M1"; }
if until_ 90 told; then ok "a member is told of the reply"; else fail "a member is told of the reply" "$(B_ "$B/notify" | head -c 300)"; fi

echo "==> 1. revoked, B hears no more of its thread"
is "revoke B" 200 "$(code -H "$AK" -X POST "$A/forum-revoke?board=$PB&ship=$BSHIP")"
M2="leak$RANDOM after the revoke"
is "A replies again" 303 "$(code -H "$AK" -X POST "$A/forum/$PB/2/comment" --data "body=${M2// /+}")"
# a note that was sent has arrived well inside this
sleep 20
if bnotify | grep -qF "$M2"; then fail "a revoked ship is not told of a reply" "B's Activity holds it"
else ok "a revoked ship is not told of a reply"; fi

echo "==> 1. banned and unbanned, B is off the roster"
r=$(A_ -X POST "$A/forum-invite?board=$PB&ship=$BSHIP")
grep -q '"ok":true' <<<"$r" && ok "B invited again" || fail "B invited again" "$r"
M3="member$RANDOM comment"
pace; forum "[%new-comment %$PB 1 ~ '$M3']" >/dev/null
landed3() { bodies 1 | grep -qF "$M3"; }
if until_ 90 landed3; then ok "a member's comment lands"; else fail "a member's comment lands" "$(thread 1 | head -c 200)"; fi
is "ban B" 200 "$(code -H "$AK" -X POST "$A/ban?ship=$BSHIP")"
is "unban B" 200 "$(code -H "$AK" -X POST "$A/unban?ship=$BSHIP")"
M4="unbanned$RANDOM comment"
pace; forum "[%new-comment %$PB 1 ~ '$M4']" >/dev/null
sleep 20
if bodies 1 | grep -qF "$M4"; then fail "an unbanned ship's comment does not land on the private board"
else ok "an unbanned ship's comment does not land on the private board"; fi
refused() { bnotes | grep -qF 'you are not a member'; }
if until_ 60 refused; then ok "and B is told it is not a member"; else fail "and B is told it is not a member" "$(bnotes | head -c 300)"; fi

echo "==> 2. pokes that name no board of A's"
B_ -o /dev/null -X POST "$B/forum-notes/clear"
FAKE="zz$RANDOM"
for i in 1 2 3 4 5 6; do forum "[%upvote %${FAKE}n$i [%post 1]]" >/dev/null; done
sleep 20
n=$(bnotes | grep -oE "${FAKE}n[1-6]" | sort -u | wc -l)
is "no refusal note for a made-up board" 0 "$n"
# a refusal on a board A does host is still noted: its default role is
# reader, so B may not post there
is "public board made" 303 "$(code -H "$AK" -X POST "$A/forum/_new" --data "name=$UB&title=Guard+$UB&role=reader")"
sleep 2
pace; forum "[%new-post %$UB 'Reader post' ~ \`'no role']" >/dev/null
noted() { bnotes | grep -qF 'cannot post'; }
if until_ 60 noted; then ok "a refusal on a real board is still noted"; else fail "a refusal on a real board is still noted" "$(bnotes | head -c 300)"; fi

echo "==> 3. refusal notes are stored cut to size"
A_ -o /dev/null -X POST "$A/forum-notes/clear"
poke forum.sig forum-note "[%$UB (crip (reap 5.000 'r'))]" >/dev/null
stored() { anotes | grep -q 'rrrrrrrrrr'; }
if until_ 60 stored; then ok "an oversize note is kept"; else fail "an oversize note is kept" "$(anotes | head -c 300)"; fi
longest=$(anotes | grep -o 'r\{10,\}' | awk '{ if (length($0) > m) m = length($0) } END { print m + 0 }')
if [ "$longest" -le 280 ]; then ok "its reason is clipped ($longest bytes)"; else fail "its reason is clipped" "$longest bytes kept"; fi
poke forum.sig forum-note "['Not A Board $FAKE' 'dropme$FAKE']" >/dev/null
poke forum.sig forum-note "[(crip (reap 5.000 'B')) 'dropme$FAKE']" >/dev/null
sleep 10
if anotes | grep -qF "dropme$FAKE"; then fail "a note whose board is no board name is dropped"
else ok "a note whose board is no board name is dropped"; fi

echo "==> 4. a comment poke with a huge path"
is "page saved"     200 "$(code -H "$AK" -X POST "$A/page-save?name=$P&type=md&new=1" --data-binary "# $P")"
is "page published" 200 "$(code -H "$AK" -X POST "$A/page-share?name=$P&mode=shared")"
is "comments on"    200 "$(code -H "$AK" -X POST "$A/page-comments?name=$P&on=1")"
sleep 3
t0=$SECONDS
poke comments.sig comment-action "[(reap 8.000 %a) 'x']" >/dev/null
C1="real$RANDOM comment"
poke comments.sig comment-action "[/$P '$C1']" >/dev/null
filed() { A_ "$A/comments-inbox" | jq -e --arg b "$C1" '[.items[] | select(.body==$b)] | length == 1' >/dev/null; }
if until_ 120 filed; then ok "the real comment lands"; else fail "the real comment lands"; fi
took=$((SECONDS - t0))
if [ "$took" -le 20 ]; then ok "and A was not held up ($took s)"; else fail "and A was not held up" "$took s"; fi

echo "$fails failure(s)"
exit $((fails > 0))
